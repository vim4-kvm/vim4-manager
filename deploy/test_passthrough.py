import hashlib
import importlib.machinery
import importlib.util
import json
import re
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


loader = importlib.machinery.SourceFileLoader('passthrough', str(Path(__file__).with_name('vim4-passthrough')))
spec = importlib.util.spec_from_loader(loader.name, loader)
passthrough = importlib.util.module_from_spec(spec)
loader.exec_module(passthrough)


class VendorPassthroughTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.controller = passthrough.VendorPassthrough(Path(self.temporary.name), '5.15.137-vim4kvm')
        edid = bytearray(128)
        edid[:8] = bytes.fromhex('00ffffffffffff00')
        edid[-1] = -sum(edid) % 256
        files = {
            passthrough.TX + 'hpd_state': '1',
            passthrough.TX + 'disp_cap': '1920x1080p60hz\n3840x2160p60hz*',
            passthrough.TX + 'rawedid': edid.hex(),
            passthrough.TX + 'dc_cap': '444,8bit',
            passthrough.TX + 'aud_cap': 'PCM, 2 ch',
            passthrough.TX + 'hdr_cap': 'SMPTE ST 2084: 1',
            passthrough.TX + 'disp_mode': 'sname: 2160p60hz\nh/v_freq: 135000/60000',
            passthrough.TX + 'attr': '444,8bit',
            passthrough.TX + 'frac_rate_policy': '0',
            passthrough.TX + 'ready': '1',
            passthrough.TX + 'test_attr': '',
            passthrough.VIDEO + 'disable_video': '0',
            passthrough.VIDEO + 'axis': '0 0 3839 2159',
            '/sys/class/display/mode': '2160p60hz',
            '/sys/class/graphics/fb0/blank': '',
            '/sys/class/drm/card0/osd0/blank': 'osd-0 blank status is 0',
            '/sys/class/drm/card0/osd1/blank': 'osd-1 blank status is 0',
            '/sys/class/hdmirx/hdmirx0/info': 'Hactive: 3840\nVactive: 2160\nFrame Rate: 5998\nInterlace: 0\nHDR EOTF: SDR\nColor Space: 2-YUV444',
            '/sys/class/video4linux/video0/name': 'vfm_cap',
            '/sys/class/video4linux/video0/status': 'vfm_started: 1\nfmt_valid: 1\nsm_state: 5\ndraining: 0',
            '/sys/class/vfm/map': 'tvpath { vdin0(1) vfm_cap(1) amvideo}',
            '/sys/module/aml_media/parameters/display_frame_count': '100',
            '/sys/module/aml_media/notes/.note.gnu.build-id': 'qualified build note',
        }
        for name, value in files.items():
            self.put(name, value)
        self.put(passthrough.QUALIFICATION, json.dumps({
            'abi': 1, 'release': self.controller.release,
            'moduleNoteSha256': hashlib.sha256(b'qualified build note').hexdigest(),
        }))
        self.qualification = patch.object(self.controller, 'qualified', return_value=True)
        self.qualification.start()
        self.addCleanup(self.qualification.stop)

    def put(self, name, value):
        path = self.controller.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)

    def test_running_requires_advancing_scanout_and_steady_ticks_do_not_reconfigure(self):
        self.assertEqual(self.controller.tick(True)['state'], 'starting')
        self.put('/sys/module/aml_media/parameters/display_frame_count', '130')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            result = self.controller.tick(True)
            self.assertEqual(result['state'], 'running')
            self.assertEqual(result['output']['width'], 3840)
            self.assertFalse(result['output']['scaled'])
            self.assertTrue(result['monitor']['hdr'])
            write.assert_not_called()
        with patch.object(passthrough.time, 'monotonic', return_value=self.controller.last_progress + 3):
            self.assertEqual(self.controller.tick(True)['state'], 'starting')

    def test_signal_loss_uses_capture_lock_not_stale_rx_geometry(self):
        self.put('/sys/class/video4linux/video0/status', 'vfm_started: 1\nfmt_valid: 0\nsm_state: 1\ndraining: 0')
        result = self.controller.tick(True)
        self.assertEqual(result['state'], 'no-signal')
        self.assertNotIn('input', result)
        self.assertEqual(self.controller.read(passthrough.VIDEO + 'disable_video'), '1')

    def test_monitor_unplug_does_not_modify_capture_or_edid(self):
        self.put(passthrough.TX + 'hpd_state', '0')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            self.assertEqual(self.controller.tick(True)['state'], 'no-monitor')
            self.assertTrue(all(call.args[0].startswith(('/sys/class/video/', '/sys/class/graphics/'))
                                or call.args[0] in passthrough.OSD_BLANKS
                                for call in write.call_args_list))

    def test_off_keeps_tee_route_and_reveals_console(self):
        route = self.controller.read('/sys/class/vfm/map')
        self.assertEqual(self.controller.tick(False)['state'], 'off')
        self.assertEqual(self.controller.read('/sys/class/vfm/map'), route)
        self.assertEqual(self.controller.read('/sys/class/graphics/fb0/blank'), '0')

    def test_capability_requires_exact_tee_route(self):
        self.assertTrue(self.controller.supported())
        self.put('/sys/class/vfm/map', 'tvpath { vdin0(1) vfm_cap}')
        self.assertFalse(self.controller.supported())

    def test_qualification_requires_matching_live_build_and_safe_owner(self):
        self.qualification.stop()
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o100600)):
            self.assertTrue(self.controller.qualified())
            self.put('/sys/module/aml_media/notes/.note.gnu.build-id', 'different module')
            self.assertFalse(self.controller.qualified())
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=1000, st_mode=0o100600)):
            self.assertFalse(self.controller.qualified())

    def test_unsupported_prepare_never_changes_capture(self):
        with patch.object(self.controller, 'qualified', return_value=False), \
                patch.object(self.controller, 'write') as write:
            with self.assertRaises(ValueError):
                self.controller.prepare()
            write.assert_not_called()

    def test_qualification_keeps_both_kernels_available_for_rollback(self):
        self.qualification.stop()
        old_release = self.controller.release
        old_note = b'qualified build note'
        new_release = '5.15.137-vim4kvm-vapb1'
        new_note = b'candidate build note'
        builds = [{'release': release, 'moduleNoteSha256': hashlib.sha256(note).hexdigest()}
                  for release, note in [(old_release, old_note), (new_release, new_note)]]
        self.put(passthrough.QUALIFICATION, json.dumps({'abi': 1, 'kernels': builds}))
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o100600)):
            for release, note in [(old_release, old_note), (new_release, new_note)]:
                self.controller.release = release
                self.put('/sys/module/aml_media/notes/.note.gnu.build-id', note.decode())
                self.assertTrue(self.controller.qualified())
            self.controller.release = old_release
            self.assertFalse(self.controller.qualified())  # New module with old release.
            self.put(passthrough.QUALIFICATION, json.dumps({'abi': 1, 'kernels': []}))
            self.assertFalse(self.controller.qualified())
        with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=0o100622)):
            self.assertFalse(self.controller.qualified())

    def test_invalid_edid_or_hdr_input_fails_before_modeset(self):
        with patch.object(self.controller, 'write') as write:
            self.put('/sys/class/hdmirx/hdmirx0/info', self.controller.read('/sys/class/hdmirx/hdmirx0/info').replace('SDR', 'HDR10'))
            with self.assertRaisesRegex(ValueError, 'HDR'):
                self.controller.tick(True)
            self.assertFalse(any(call.args[0].startswith(passthrough.TX) for call in write.call_args_list))
        self.put(passthrough.TX + 'rawedid', '00')
        with self.assertRaisesRegex(ValueError, 'EDID'):
            self.controller.monitor()

    def test_missing_audio_service_does_not_change_request_or_hardware(self):
        with patch.object(self.controller, 'write') as write:
            with self.assertRaisesRegex(ValueError, '音频'):
                self.controller.set(True, True)
            write.assert_not_called()
        self.assertFalse(self.controller.path(passthrough.RUNTIME + 'request.json').exists())

    def test_audio_failure_status_preserves_video_and_saved_audio_preference(self):
        self.put(passthrough.RUNTIME + 'request.json', json.dumps({'enabled': True, 'audio': True, 'revision': 7}))
        observed = {'revision': 7, 'heartbeat': 100,
                    'state': {'supported': True, 'enabled': True, 'state': 'running', 'audio': False}}
        self.put(passthrough.RUNTIME + 'state.json', json.dumps(observed))
        self.put(passthrough.RUNTIME + 'audio-state.json', json.dumps({'revision': 7, 'heartbeat': 100, 'state': 'error'}))
        with patch.object(passthrough.time, 'monotonic', return_value=100):
            with patch.object(self.controller, 'write') as write:
                state = self.controller.status()
                write.assert_not_called()
        self.assertTrue(state['audio'])
        self.assertEqual(state['audioState'], 'error')
        self.assertEqual(state['state'], 'running')
        self.assertEqual(self.controller.load(passthrough.RUNTIME + 'state.json'), observed)

    def test_set_waits_for_worker_actual_state(self):
        def start(*args, **kwargs):
            requested = self.controller.load(passthrough.RUNTIME + 'request.json')
            passthrough.atomic_json(self.controller.path(passthrough.RUNTIME + 'state.json'), {
                'revision': requested['revision'], 'heartbeat': passthrough.time.monotonic(),
                'state': {'supported': True, 'enabled': True, 'audio': False, 'state': 'no-monitor'},
            })
        self.controller.run = Mock(side_effect=start)
        self.assertEqual(self.controller.set(True, False)['state'], 'no-monitor')

    def test_status_rejects_dead_or_stale_worker(self):
        passthrough.atomic_json(self.controller.path(passthrough.RUNTIME + 'request.json'), {'enabled': True, 'revision': 1})
        with self.assertRaisesRegex(ValueError, '未响应'):
            self.controller.status()
        passthrough.atomic_json(self.controller.path(passthrough.RUNTIME + 'state.json'), {
            'revision': 1, 'heartbeat': passthrough.time.monotonic() - 10, 'state': {},
        })
        with self.assertRaisesRegex(ValueError, '未响应'):
            self.controller.status()

    def test_scaling_and_fractional_refresh_follow_sink_intersection(self):
        mode = passthrough.select_mode({'height': 2160, 'refreshHz': 59.94}, {(1080, 60): '1080p60hz'})
        self.assertEqual(mode, ('1080p60hz', 1920, 1080, True))
        with self.assertRaises(ValueError):
            passthrough.select_mode({'height': 2160, 'refreshHz': 120}, {(1080, 60): '1080p60hz'})

    def assert_no_modeset(self, write):
        self.assertFalse(any(call.args[0].startswith(passthrough.TX)
                             or call.args[0] == '/sys/class/display/mode' for call in write.call_args_list))

    def test_rx_rate_jitter_never_reprograms_unchanged_input(self):
        self.controller.tick(True)
        original = self.controller.read('/sys/class/hdmirx/hdmirx0/info')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            for index, rate in enumerate([5999, 5997, 5998, 5996, 5998, 5995, 5999] * 6):
                self.put('/sys/class/hdmirx/hdmirx0/info', original.replace('5998', str(rate)))
                self.put('/sys/module/aml_media/parameters/display_frame_count', str(101 + index))
                with patch.object(passthrough.time, 'monotonic', return_value=100 + index):
                    self.assertEqual(self.controller.tick(True)['state'], 'running')
            self.assert_no_modeset(write)
            self.assertEqual(self.controller.read(passthrough.TX + 'frac_rate_policy'), '0')

    def test_tx_aliases_and_annotations_are_normalized(self):
        self.controller.tick(True)
        self.put(passthrough.TX + 'disp_mode', 'sname: 3840x2160p60hz\nh/v_freq: 135000/60000\r\n')
        self.put(passthrough.TX + 'attr', ' 444 , 8bit limited\r\n\n')
        self.put(passthrough.TX + 'frac_rate_policy', 'frac_rate_policy: 0\r\n')
        self.put(passthrough.TX + 'ready', 'ready=1\n')
        self.put('/sys/module/aml_media/parameters/display_frame_count', '130')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            self.assertEqual(self.controller.tick(True)['state'], 'running')
            self.assert_no_modeset(write)

    def test_recorded_blackout_rate_trace_does_not_reconfigure(self):
        self.controller.tick(True)
        original = self.controller.read('/sys/class/hdmirx/hdmirx0/info')
        rates = [5999, 5988, 5999, 5987, 5998, 5988, 5999, 5999, 5998, 5998,
                 5998, 5998, 5998, 5999, 5998, 5998, 5998, 5998, 5998, 5998,
                 5998, 5998, 5999, 5998, 5999, 5998, 5999, 5999, 5995, 5999,
                 5998, 5999, 5998, 5999, 5998, 5998, 5999, 5998, 5998, 5998,
                 5999, 5998, 5998, 5998, 5999, 5987, 5998, 5999, 5998, 5998,
                 5998, 5999, 5998, 5998, 5999, 5987, 5998, 5999, 5998, 5998,
                 5988, 5999, 5998, 5998, 5999, 5999, 5999, 5999, 5998, 5998]
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            for index, rate in enumerate(rates):
                self.put('/sys/class/hdmirx/hdmirx0/info', original.replace('5998', str(rate)))
                self.put('/sys/module/aml_media/parameters/display_frame_count', str(200 + index))
                with patch.object(passthrough.time, 'monotonic', return_value=100 + index * .5):
                    self.controller.tick(True)
            self.assert_no_modeset(write)

    def test_ready_glitch_is_debounced_without_any_modeset(self):
        self.controller.tick(True)
        self.put('/sys/module/aml_media/parameters/display_frame_count', '130')
        self.controller.tick(True)
        self.put(passthrough.TX + 'ready', '0')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            for now, expected in ((100, 'running'), (101, 'running'), (103, 'starting')):
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.put('/sys/module/aml_media/parameters/display_frame_count', str(now + 100))
                    self.assertEqual(self.controller.tick(True)['state'], expected)
            self.put(passthrough.TX + 'ready', '1')
            self.put('/sys/module/aml_media/parameters/display_frame_count', '300')
            with patch.object(passthrough.time, 'monotonic', return_value=104):
                self.assertEqual(self.controller.tick(True)['state'], 'running')
            self.assert_no_modeset(write)

    def test_unexpected_tx_readback_does_not_become_a_modeset_trigger(self):
        self.controller.tick(True)
        self.put(passthrough.TX + 'attr', 'rgb,8bit')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            for now in (100, 101, 103, 110):
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.assertEqual(self.controller.tick(True)['state'], 'starting')
            self.assert_no_modeset(write)

    def hardware_write(self, name, value):
        passthrough.VendorPassthrough.write(self.controller, name, value)
        if name == passthrough.TX + 'test_attr':
            self.put(passthrough.TX + 'attr', value)
        if name == passthrough.TX + 'disp_mode':
            frequency = int(re.search(r'p(\d+)hz', value)[1])
            fractional = int(self.controller.read(passthrough.TX + 'frac_rate_policy'))
            self.put(name, f'sname: {value}\nh/v_freq: 67500/{round(frequency * 1000 / (1.001 if fractional else 1))}')

    def test_real_input_change_is_debounced_and_programmed_once(self):
        self.controller.tick(True)
        original = self.controller.read('/sys/class/hdmirx/hdmirx0/info')
        self.put('/sys/class/hdmirx/hdmirx0/info', original.replace('3840', '1920').replace('2160', '1080'))
        with patch.object(self.controller, 'write', side_effect=self.hardware_write) as write:
            for now in (100, 101):
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.assertEqual(self.controller.tick(True)['state'], 'starting')
            self.assert_no_modeset(write)
            for now in (102, 103, 105):
                self.put('/sys/module/aml_media/parameters/display_frame_count', str(200 + now))
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.assertEqual(self.controller.tick(True)['state'], 'running')
            self.assertEqual(sum(call.args[0] == passthrough.TX + 'disp_mode' for call in write.call_args_list), 1)

    def test_brief_input_geometry_change_is_not_programmed(self):
        self.controller.tick(True)
        original = self.controller.read('/sys/class/hdmirx/hdmirx0/info')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            self.put('/sys/class/hdmirx/hdmirx0/info', original.replace('2160', '1080').replace('3840', '1920'))
            with patch.object(passthrough.time, 'monotonic', return_value=100):
                self.controller.tick(True)
            self.put('/sys/class/hdmirx/hdmirx0/info', original)
            for now in (101, 104):
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.controller.tick(True)
            self.assert_no_modeset(write)

    def test_true_fractional_rate_change_programs_once_after_settling(self):
        self.controller.tick(True)
        original = self.controller.read('/sys/class/hdmirx/hdmirx0/info')
        with patch.object(self.controller, 'write', side_effect=self.hardware_write) as write:
            for index in range(14):
                self.put('/sys/class/hdmirx/hdmirx0/info', original.replace('5998', '5994'))
                self.put('/sys/module/aml_media/parameters/display_frame_count', str(200 + index))
                with patch.object(passthrough.time, 'monotonic', return_value=100 + index):
                    self.controller.tick(True)
            self.assertEqual(self.controller.read(passthrough.TX + 'frac_rate_policy'), '1')
            self.assertEqual(sum(call.args[0] == passthrough.TX + 'disp_mode' for call in write.call_args_list), 1)

    def test_failed_modeset_is_not_retried_on_every_tick(self):
        self.controller.tick(True)
        original = self.controller.read('/sys/class/hdmirx/hdmirx0/info')
        self.put('/sys/class/hdmirx/hdmirx0/info', original.replace('2160', '1080').replace('3840', '1920'))
        def write_failed(name, value):
            if name == '/sys/class/display/mode':
                raise OSError('modeset failed')
            self.hardware_write(name, value)
        with patch.object(self.controller, 'write', side_effect=write_failed) as write:
            with patch.object(passthrough.time, 'monotonic', return_value=100):
                self.controller.tick(True)
            with patch.object(passthrough.time, 'monotonic', return_value=103):
                with self.assertRaises(OSError):
                    self.controller.tick(True)
            for now in (104, 110):
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.controller.tick(True)
            self.assertEqual(sum(call.args[0] == '/sys/class/display/mode' for call in write.call_args_list), 1)

    def test_status_polling_never_calls_tick_or_writes_hardware(self):
        with patch.object(self.controller, 'tick', side_effect=AssertionError('status called tick')), \
                patch.object(self.controller, 'write') as write, \
                patch.object(passthrough, 'atomic_json') as atomic:
            for unused in range(10):
                self.controller.status()
            write.assert_not_called()
            atomic.assert_not_called()
        passthrough.atomic_json(self.controller.path(passthrough.RUNTIME + 'request.json'), {'revision': 1, 'enabled': True})
        passthrough.atomic_json(self.controller.path(passthrough.RUNTIME + 'state.json'), {
            'revision': 1, 'heartbeat': passthrough.time.monotonic(),
            'state': {'supported': True, 'enabled': True, 'state': 'running', 'audio': False},
        })
        with patch.object(self.controller, 'tick', side_effect=AssertionError('status called tick')), \
                patch.object(self.controller, 'write') as write, \
                patch.object(passthrough, 'atomic_json') as atomic:
            for unused in range(10):
                self.assertEqual(self.controller.status()['state'], 'running')
            write.assert_not_called()
            atomic.assert_not_called()

    def test_initial_ready_zero_does_not_force_a_modeset(self):
        self.put(passthrough.TX + 'ready', '0')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            for now in (100, 101, 103):
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.assertEqual(self.controller.tick(True)['state'], 'starting')
            self.assert_no_modeset(write)

    def test_second_watch_is_rejected_before_hardware_writes(self):
        lock_path = self.controller.path(passthrough.RUNTIME + 'watch.lock')
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open('w') as held:
            passthrough.fcntl.flock(held, passthrough.fcntl.LOCK_EX | passthrough.fcntl.LOCK_NB)
            with patch.object(self.controller, 'tick') as tick:
                with self.assertRaises(BlockingIOError):
                    self.controller.watch()
                tick.assert_not_called()

    def test_persistent_osd_guard_survives_restart_and_restores_original_policy(self):
        self.put(passthrough.OSD_BLANKS[1], 'osd-1 blank status is 1')
        self.controller.tick(True)
        self.assertTrue(all(passthrough.scalar(self.controller.read(name)) == 1 for name in passthrough.OSD_BLANKS))
        self.controller = passthrough.VendorPassthrough(self.controller.root, self.controller.release)
        self.controller.tick(True)
        self.controller.tick(False)
        self.assertEqual([passthrough.scalar(self.controller.read(name)) for name in passthrough.OSD_BLANKS], [0, 1])
        self.assertFalse(self.controller.path(passthrough.OSD_SAVED).exists())

    def test_software_blank_cache_does_not_override_persistent_guard_readback(self):
        self.controller.tick(True)
        self.put(passthrough.OSD_BLANKS[0], 'osd-0 blank status is 0')
        with patch.object(self.controller, 'write', wraps=self.controller.write) as write:
            self.controller.tick(True)
            write.assert_any_call(passthrough.OSD_BLANKS[0], 1)
            self.assert_no_modeset(write)

    def test_hpd_reconnect_restores_driver_rgb_reset_once_and_hides_console(self):
        self.controller.tick(True)
        with patch.object(self.controller, 'write', side_effect=self.hardware_write) as write:
            self.put(passthrough.TX + 'hpd_state', '0')
            with patch.object(passthrough.time, 'monotonic', return_value=100):
                self.assertEqual(self.controller.tick(True)['state'], 'no-monitor')
            self.put(passthrough.TX + 'hpd_state', '1')
            self.put(passthrough.TX + 'rawedid', '00')
            with patch.object(passthrough.time, 'monotonic', return_value=101):
                failed = self.controller.cycle({'enabled': True, 'revision': 1})
                self.assertIn('EDID', failed['error'])
            self.assertTrue(all(self.controller.read(name) == '1' for name in passthrough.OSD_BLANKS))
            edid = bytearray(128)
            edid[:8] = bytes.fromhex('00ffffffffffff00')
            edid[-1] = -sum(edid) % 256
            self.put(passthrough.TX + 'rawedid', edid.hex())
            with patch.object(passthrough.time, 'monotonic', return_value=102):
                self.assertEqual(self.controller.tick(True)['state'], 'starting')
            self.put(passthrough.TX + 'attr', 'rgb,8bit')
            self.put(passthrough.TX + 'disp_mode', 'sname: 1080p60hz\nh/v_freq: 67500/60000')
            for now in (103, 104, 106, 107):
                self.put('/sys/module/aml_media/parameters/display_frame_count', str(200 + now))
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.controller.tick(True)
            self.assertEqual(sum(call.args[0] == passthrough.TX + 'disp_mode' for call in write.call_args_list), 1)
            self.assertEqual(self.controller.read(passthrough.TX + 'attr'), '444,8bit')
            self.assertTrue(all(self.controller.read(name) == '1' for name in passthrough.OSD_BLANKS))
            self.assertFalse(any(call.args[0].startswith('/sys/class/graphics/') and call.args[1] == 0 for call in write.call_args_list))

    def test_edid_change_without_hpd_edge_requalifies_sink(self):
        self.controller.tick(True)
        edid = bytearray.fromhex(self.controller.read(passthrough.TX + 'rawedid'))
        edid[10] = 1
        edid[-1] = 0
        edid[-1] = -sum(edid) % 256
        self.put(passthrough.TX + 'rawedid', edid.hex())
        self.put(passthrough.TX + 'attr', 'rgb,8bit')
        with patch.object(self.controller, 'write', side_effect=self.hardware_write) as write:
            for now in (100, 102, 104, 105):
                self.put('/sys/module/aml_media/parameters/display_frame_count', str(200 + now))
                with patch.object(passthrough.time, 'monotonic', return_value=now):
                    self.controller.tick(True)
            self.assertEqual(sum(call.args[0] == passthrough.TX + 'disp_mode' for call in write.call_args_list), 1)

    def test_error_cleanup_failure_does_not_terminate_watch_cycle(self):
        with patch.object(self.controller, 'tick', side_effect=ValueError('EDID transient')), \
                patch.object(self.controller, 'blank', side_effect=OSError('OSD temporarily unavailable')), \
                patch.object(self.controller, 'update', side_effect=OSError('VD1 temporarily unavailable')):
            result = self.controller.cycle({'enabled': True, 'revision': 1})
        self.assertEqual(result['state']['state'], 'starting')
        self.assertEqual(result['error'], 'EDID transient')
        self.assertIn('heartbeat', result)
        self.assertEqual(self.controller.cycle({'enabled': True, 'revision': 2})['revision'], 2)

    def test_kernel_hpd_events_recover_edge_missed_by_polling(self):
        self.controller.tick(True)
        events = Mock()
        events.recvfrom.side_effect = [
            (b'SUBSYSTEM=amhdmitx\0hdmitx_hpd=0\0', (0, 1)),
            (b'SUBSYSTEM=amhdmitx\0hdmitx_hpd=1\0', (0, 1)), BlockingIOError(),
        ]
        self.controller.drain_hotplug(events)
        self.assertEqual(self.controller.last_hpd, 1)
        self.assertTrue(self.controller.reconnecting)
        self.assertIsNone(self.controller.mode_key)

    def test_other_or_userspace_uevents_do_not_reconfigure_output(self):
        self.controller.tick(True)
        key = self.controller.mode_key
        events = Mock()
        events.recvfrom.side_effect = [
            (b'SUBSYSTEM=amhdmitx\0hdmitx_hpd=1\0', (123, 1)),
            (b'SUBSYSTEM=other\0hdmitx_hpd=1\0', (0, 1)), BlockingIOError(),
        ]
        self.controller.drain_hotplug(events)
        self.assertEqual(self.controller.mode_key, key)
        self.assertFalse(self.controller.reconnecting)


if __name__ == '__main__':
    unittest.main()
