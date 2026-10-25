import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location('passthrough_audio', Path(__file__).with_name('vim4_passthrough_audio.py'))
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


class AudioWorkerTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.now = 100
        self.values = {'Audio In Source': 0, 'HDMITX Audio Source Select': 3,
                       'Hw resample module': 8, 'Hardware resample enable': 3,
                       'HDMIIN audio samplerate': 3, 'HDMIIN NONAUDIO': 0,
                       'HDMIIN audio channels': 1, 'HDMIIN audio stable': 1}
        self.writes = []

        def mixer(command, **unused):
            name = command[4].removeprefix('name=')
            if command[3] == 'cset':
                self.values[name] = int(command[5])
                self.writes.append((name, self.values[name]))
            return SimpleNamespace(stdout=f'  : values={self.values[name]}\n')

        self.children = []

        def spawn(*unused, **unused_kwargs):
            self.worker.controls.apply(True)
            child = Mock(pid=len(self.children) + 70)
            child.poll.return_value = None
            def waited(**unused):
                child.poll.configure_mock(return_value=0)
                self.worker.controls.apply(False)
            child.wait.side_effect = waited
            self.children.append(child)
            return child

        self.spawn = Mock(side_effect=spawn)
        self.guard = Mock()
        self.worker = audio.AudioWorker(self.root, mixer, self.spawn, lambda: self.now,
                                        pcm_factory=lambda: self.guard)
        self.put(audio.RUNTIME / 'request.json', '{}')
        self.put('/proc/asound/pcm', '00-06: EXTN-dummy : capture 1\n00-01: SPDIF-dummy : playback 1')
        self.put('/sys/class/amhdmitx/amhdmitx0/aud_cap', 'PCM, 2 ch, 32/44.1/48 kHz, 16/24 bit')
        self.request = {'enabled': True, 'audio': True, 'revision': 4}
        self.video = {'heartbeat': self.now, 'state': {'supported': True, 'enabled': True,
                      'state': 'running', 'input': {'audio': True}, 'monitor': {'audio': True}}}

    def put(self, name, value):
        path = self.worker.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def cycle(self):
        return self.worker.cycle(self.request, self.video)['state']

    def start(self):
        self.assertEqual(self.cycle(), 'starting')
        self.assertEqual(self.cycle(), 'starting')
        self.put(audio.RUNTIME / 'audio-pcm.json', json.dumps({
            'pid': self.worker.child.pid, 'heartbeat': self.now, 'frames': 24000}))
        self.assertEqual(self.cycle(), 'running')

    def test_independent_pcm_progress_and_preference_off_restore_routes(self):
        self.start()
        self.assertEqual(self.spawn.call_args.args[0][-2:], ['audio-pcm', '48000'])
        self.assertEqual(self.values['Audio In Source'], 8)
        self.request['audio'] = False
        self.assertEqual(self.cycle(), 'off')
        self.assertEqual(self.values['Audio In Source'], 8)
        self.assertEqual(self.values['HDMITX Audio Source Select'], 3)
        self.assertIsNone(self.worker.child)
        self.assertFalse(self.worker.path(audio.RUNTIME / 'audio-before.json').exists())

    def test_rate_switch_replaces_child_instead_of_relabeling_48k(self):
        self.start()
        previous = self.worker.child
        self.values['HDMIIN audio samplerate'] = 2
        self.assertEqual(self.cycle(), 'starting')
        previous.terminate.assert_called_once()
        self.assertEqual(self.cycle(), 'starting')
        self.assertEqual(self.spawn.call_args.args[0][-1], '44100')

    def test_output_hotplug_stops_audio_and_reconnect_restarts_without_video_writes(self):
        original = json.loads(json.dumps(self.video))
        self.start()
        self.video['state'].pop('monitor')
        self.assertEqual(self.cycle(), 'unavailable')
        self.assertEqual(self.values['Audio In Source'], 8)
        self.video = original
        self.start()
        self.assertEqual(len(self.children), 2)
        self.assertEqual(self.video, original)
        self.assertEqual({name for name, value in self.writes}, set(audio.ROUTES) | set(audio.ISOLATED_RESAMPLE))

    def test_source_loss_and_video_off_never_keep_a_playback_pcm(self):
        self.start()
        self.video['state']['state'] = 'no-signal'
        self.assertEqual(self.cycle(), 'waiting')
        self.assertIsNone(self.worker.child)
        self.request['enabled'] = False
        self.assertEqual(self.cycle(), 'off')

    def test_sink_without_pcm_or_native_rate_never_opens_audio(self):
        for capabilities in ('', 'AC-3, 6 ch, 48 kHz', 'PCM, 2 ch, 32 kHz'):
            with self.subTest(capabilities=capabilities):
                self.put('/sys/class/amhdmitx/amhdmitx0/aud_cap', capabilities)
                self.assertEqual(self.cycle(), 'unavailable')
        self.spawn.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_compressed_multichannel_or_unknown_input_does_not_forward_noise(self):
        for name, value in (('HDMIIN NONAUDIO', 1), ('HDMIIN audio channels', 7),
                            ('HDMIIN audio samplerate', 0)):
            with self.subTest(name=name):
                previous = self.values[name]
                self.values[name] = value
                self.assertEqual(self.cycle(), 'error')
                self.values[name] = previous
        self.spawn.assert_not_called()
        self.assertEqual(self.writes, [])

    def test_exited_bridge_has_bounded_retry_and_does_not_modify_video(self):
        self.start()
        self.worker.child.poll.return_value = 1
        original = json.loads(json.dumps(self.video))
        self.assertEqual(self.cycle(), 'error')
        for unused in range(20):
            self.assertEqual(self.cycle(), 'error')
        self.assertEqual(self.spawn.call_count, 1)
        self.now += 5
        self.video['heartbeat'] = self.now
        self.assertEqual(self.cycle(), 'starting')
        self.assertEqual(self.cycle(), 'starting')
        self.assertEqual(self.spawn.call_count, 2)
        original['heartbeat'] = self.now
        self.assertEqual(self.video, original)

    def test_alive_but_stalled_bridge_is_not_reported_as_running(self):
        self.start()
        self.now += 5
        self.video['heartbeat'] = self.now
        self.assertEqual(self.cycle(), 'error')
        self.assertIsNone(self.worker.child)

    def test_cleanup_failure_is_contained_and_next_cycle_can_recover(self):
        with patch.object(self.worker, 'source_rate', side_effect=OSError('unplugged')):
            with patch.object(self.worker, 'stop', side_effect=OSError('cleanup failed')):
                self.assertEqual(self.cycle(), 'error')
        self.now += 5
        self.video['heartbeat'] = self.now
        self.start()

    def test_saved_route_policy_survives_restart_and_external_changes_are_preserved(self):
        self.put(audio.RUNTIME / 'audio-before.json', json.dumps({'Audio In Source': 0, 'HDMITX Audio Source Select': 3}))
        self.values['Audio In Source'] = 8
        self.values['HDMITX Audio Source Select'] = 0
        self.start()
        self.values['HDMITX Audio Source Select'] = 4
        self.request['audio'] = False
        self.assertEqual(self.cycle(), 'off')
        self.assertEqual(self.values['Audio In Source'], 0)
        self.assertEqual(self.values['HDMITX Audio Source Select'], 4)

    def test_resampler_used_by_kvm_is_never_changed(self):
        self.values['Hw resample module'] = 1
        self.start()
        self.request['audio'] = False
        self.assertEqual(self.cycle(), 'off')
        self.assertFalse(any(name in audio.ISOLATED_RESAMPLE for name, value in self.writes))
        self.assertEqual(self.values['Hw resample module'], 1)

    def test_isolated_resampler_is_bypassed_and_original_policy_restored(self):
        self.start()
        self.assertEqual(self.values['Hardware resample enable'], 0)
        self.assertEqual(self.values['Hw resample module'], 0)
        self.request['audio'] = False
        self.assertEqual(self.cycle(), 'off')
        self.assertEqual(self.values['Hardware resample enable'], 3)
        self.assertEqual(self.values['Hw resample module'], 8)

    def test_crash_cleanup_does_not_change_routes_when_an_endpoint_is_owned_elsewhere(self):
        self.start()
        self.worker.child.poll.return_value = 1
        self.guard.acquire.side_effect = OSError('busy')
        before = dict(self.values)
        self.assertEqual(self.cycle(), 'error')
        self.assertEqual(self.values, before)
        self.assertTrue(self.worker.path(audio.RUNTIME / 'audio-before.json').exists())

    def test_configured_external_input_is_not_replaced_by_hdmi(self):
        self.values['Audio In Source'] = 5
        self.assertEqual(self.cycle(), 'error')
        self.assertEqual(self.writes, [])
        self.spawn.assert_not_called()

    def test_unavailable_pcm_does_not_change_output_or_resampler_routes(self):
        self.values['Audio In Source'] = 8
        self.spawn.side_effect = OSError('PCM occupied')
        self.assertEqual(self.cycle(), 'starting')
        self.assertEqual(self.cycle(), 'error')
        self.assertEqual(self.writes, [])


if __name__ == '__main__':
    unittest.main()
