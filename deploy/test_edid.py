import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_helper import helper


class EDIDTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(helper.platform, 'release', return_value='5.15-test'))
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.config = self.root / 'config.json'
        self.old = Path(__file__).with_name('edid').joinpath('rtk-uhd-hdr.bin').read_bytes()
        changed = bytearray(self.old)
        changed[12] ^= 1
        changed[127] = (-sum(changed[:127])) % 256
        self.new = bytes(changed)
        self.presets = [{'id': 'VIM4-4K60', 'name': 'Original', 'description': '', 'data': self.old},
                        {'id': 'test', 'name': 'Test', 'description': '', 'data': self.new}]
        self.config.write_text(json.dumps({'hdmi_edid_string': self.old.hex(), 'unrelated': {'keep': True}}))
        self.original_config = self.config.read_bytes()
        self.enterContext(patch.object(helper, 'JETKVM_CONFIG', self.config))
        self.enterContext(patch.object(helper, 'edid_catalog', return_value=self.presets))
        self.enterContext(patch.object(helper, 'saved_edid', return_value=('VIM4-4K60', self.old)))
        self.enterContext(patch.object(helper, 'loaded_edid', return_value=self.old))
        self.enterContext(patch.object(helper.os, 'sync'))
        self.run = self.enterContext(patch.object(helper.subprocess, 'run', return_value=subprocess.CompletedProcess([], 3)))
        self.services = self.enterContext(patch.object(helper, 'systemctl'))
        self.load = self.enterContext(patch.object(helper, 'load_edid'))

    def test_applies_and_preserves_private_config(self):
        helper.select_edid('test')
        config = json.loads(self.config.read_text())
        self.assertEqual(bytes.fromhex(config['hdmi_edid_string']), self.new)
        self.assertEqual(config['unrelated'], {'keep': True})
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.load.assert_called_once_with('test', self.new)
        self.services.assert_not_called()

    def test_mainline_releases_active_capture_before_edid_and_restarts_same_app(self):
        events = []
        self.run.side_effect = lambda args, **kwargs: subprocess.CompletedProcess(
            args, 0 if args[-1] == helper.APPS['onekvm'] else 3)
        self.services.side_effect = lambda action, unit: events.append((action, unit))
        self.load.side_effect = lambda *args: events.append(('load', 'edid'))
        with patch.object(helper.platform, 'release', return_value='7.3-test'), \
                patch.object(helper, 'check_pikvm_media'):
            helper.select_edid('test')
        self.assertEqual(events, [('stop', helper.APPS['onekvm']), ('load', 'edid'),
                                  ('start', helper.APPS['onekvm'])])

    def test_current_preset_does_not_disconnect_running_jetkvm(self):
        self.run.return_value.returncode = 0
        helper.select_edid('VIM4-4K60')
        self.services.assert_not_called()
        self.load.assert_not_called()
        self.assertEqual(self.config.read_bytes(), self.original_config)

    def test_snapshot_after_shutdown_preserves_last_saved_settings(self):
        self.run.return_value.returncode = 0
        events = []
        def service(action, unit):
            events.append(action)
            if action == 'stop':
                self.config.write_text(json.dumps({'lastSetting': 42}))
        self.services.side_effect = service
        self.load.side_effect = lambda *args: events.append('load')
        with patch.object(helper, 'check_pikvm_media'):
            helper.select_edid('test')
        self.assertEqual(events, ['stop', 'load', 'start'])
        self.assertEqual(json.loads(self.config.read_text())['lastSetting'], 42)

    def test_load_failure_restores_both_configurations(self):
        self.load.side_effect = [OSError('failed'), None]
        with self.assertRaisesRegex(ValueError, '已恢复原配置'):
            helper.select_edid('test')
        self.assertEqual(self.config.read_bytes(), self.original_config)
        self.assertEqual(self.load.call_args.args, ('VIM4-4K60', self.old))

    def test_failed_recovery_is_not_reported_as_success(self):
        self.load.side_effect = OSError('failed')
        with self.assertRaisesRegex(ValueError, '恢复原配置失败'):
            helper.select_edid('test')

    def test_unknown_id_and_malformed_config_do_not_stop_service(self):
        self.run.return_value.returncode = 0
        with self.assertRaisesRegex(ValueError, '未知'):
            helper.select_edid('../../test')
        self.config.write_text('[]')
        with self.assertRaisesRegex(ValueError, 'JSON 对象'):
            helper.select_edid('test')
        self.services.assert_not_called()
        self.load.assert_not_called()

    def test_new_config_is_removed_on_rollback(self):
        self.config.unlink()
        self.load.side_effect = [OSError('failed'), None]
        with self.assertRaisesRegex(ValueError, '已恢复原配置'):
            helper.select_edid('test')
        self.assertFalse(self.config.exists())

    def test_restart_failure_restores_and_restarts_original(self):
        self.run.return_value.returncode = 0
        self.services.side_effect = [None, OSError('start failed'), None, None]
        with patch.object(helper, 'check_pikvm_media'), self.assertRaisesRegex(ValueError, '已恢复原配置'):
            helper.select_edid('test')
        self.assertEqual(self.config.read_bytes(), self.original_config)
        self.assertEqual([c.args[0] for c in self.services.call_args_list], ['stop', 'start', 'stop', 'start'])

    def test_checksum_and_padded_base_block(self):
        invalid = bytearray(self.old)
        invalid[42] ^= 1
        with self.assertRaises(ValueError):
            helper.validate_edid(bytes(invalid))
        base = bytearray(self.old[:128])
        base[126] = 0
        base[127] = (-sum(base[:127])) % 256
        padded = bytes(base) + bytes(128)
        self.assertEqual(helper.validate_edid(bytes(base)), padded)
        self.assertEqual(helper.validate_edid(padded), padded)
