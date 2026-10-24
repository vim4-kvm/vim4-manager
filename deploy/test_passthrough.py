import hashlib
import importlib.machinery
import importlib.util
import json
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


if __name__ == '__main__':
    unittest.main()
