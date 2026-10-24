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

    def test_invalid_edid_or_hdr_input_fails_before_modeset(self):
        with patch.object(self.controller, 'write') as write:
            self.put('/sys/class/hdmirx/hdmirx0/info', self.controller.read('/sys/class/hdmirx/hdmirx0/info').replace('SDR', 'HDR10'))
            with self.assertRaisesRegex(ValueError, 'HDR'):
                self.controller.tick(True)
            self.assertFalse(any(call.args[0].startswith(passthrough.TX) for call in write.call_args_list))
        self.put(passthrough.TX + 'rawedid', '00')
        with self.assertRaisesRegex(ValueError, 'EDID'):
            self.controller.monitor()

    def test_audio_rejection_does_not_change_request_or_hardware(self):
        with patch.object(self.controller, 'write') as write:
            with self.assertRaisesRegex(ValueError, '音频'):
                self.controller.set(True, True)
            write.assert_not_called()
        self.assertFalse(self.controller.path(passthrough.RUNTIME + 'request.json').exists())

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


if __name__ == '__main__':
    unittest.main()
