import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('helper', str(Path(__file__).with_name('vim4-manager-helper')))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class HelperTest(unittest.TestCase):
    def test_mounted_pikvm_media_blocks_switch_before_any_service_change(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        state, lun = root / 'state', root / 'lun'
        state.write_text('{}')
        lun.write_text('/var/lib/kvmd/msd/disk.img\n')
        with patch.object(helper, 'PIKVM_USB_STATE', state), patch.object(helper, 'PIKVM_LUN_FILE', lun):
            for args in (['select', 'nanokvm'], ['restart', 'vim4-pikvm.service'],
                         ['restart', 'vim4-kvm-hdmi.service']):
                with self.subTest(args=args), self.assertRaisesRegex(ValueError, 'Eject'):
                    helper.main(args)
        self.assertEqual(self.calls, [])

    def test_wifi_enable_restores_primary_link_only(self):
        result = type('Result', (), {'stdout': 'eth0:ethernet\nwlan0:wifi\nwlan1:wifi\n'})()
        with patch.object(helper.subprocess, 'run', return_value=result) as run:
            helper.main(['wifi', 'on'])
        self.assertEqual([call.args[0] for call in run.call_args_list][1:], [
            ['nmcli', 'radio', 'wifi', 'on'], ['ip', 'link', 'set', 'dev', 'wlan0', 'up']])

    def test_wifi_disable_does_not_restore_link(self):
        result = type('Result', (), {'stdout': 'wlan0:wifi\n'})()
        with patch.object(helper.subprocess, 'run', return_value=result) as run:
            helper.main(['wifi', 'off'])
        self.assertEqual(len(run.call_args_list), 2)
        self.assertEqual(run.call_args.args[0], ['nmcli', 'radio', 'wifi', 'off'])

    def test_wifi_missing_adapter_does_not_change_radio(self):
        result = type('Result', (), {'stdout': 'eth0:ethernet\n'})()
        with patch.object(helper.subprocess, 'run', return_value=result) as run:
            with self.assertRaises(ValueError):
                helper.main(['wifi', 'on'])
        self.assertEqual(run.call_count, 1)

    def setUp(self):
        self.calls = []
        self.active = set()
        patcher = patch.object(helper, 'systemctl', side_effect=lambda *args: self.calls.append(args))
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_is_active(self, args, **kwargs):
        return type('Result', (), {'returncode': 0 if args[-1] in self.active else 3})()

    def test_select_disables_other_before_enabling(self):
        with patch.object(helper, 'installed', return_value=True), patch.object(helper.os, 'sync') as sync:
            helper.main(['select', 'jetkvm'])
        self.assertEqual(self.calls, [('disable', 'nanokvm.service', 'one-kvm.service', 'vim4-pikvm.service'), ('enable', 'vim4-kvm.service'),
                                      ('stop', 'nanokvm.service', 'one-kvm.service', 'vim4-pikvm.service'),
                                      ('restart', 'vim4-kvm.service')])
        sync.assert_called_once()

    def test_failed_stop_never_starts_replacement(self):
        def fail_stop(*args):
            self.calls.append(args)
            if args[0] == 'stop':
                raise TimeoutError('old process still owns encoder')
        with patch.object(helper, 'installed', return_value=True), \
             patch.object(helper, 'systemctl', side_effect=fail_stop):
            with self.assertRaises(TimeoutError):
                helper.main(['select', 'jetkvm'])
        self.assertFalse(any(call[0] == 'restart' for call in self.calls))

    def test_restart_also_waits_for_other_application(self):
        with patch.object(helper, 'installed', return_value=True):
            helper.main(['restart', 'nanokvm.service'])
        self.assertEqual(self.calls, [('stop', 'vim4-kvm.service', 'one-kvm.service', 'vim4-pikvm.service'), ('restart', 'nanokvm.service')])

    def test_all_apps_release_resources_before_replacement(self):
        for app, unit in helper.APPS.items():
            with self.subTest(app=app), patch.object(helper, 'installed', return_value=True), patch.object(helper.os, 'sync'):
                self.calls.clear()
                helper.main(['select', app])
                stopped = next(call[1:] for call in self.calls if call[0] == 'stop')
                self.assertEqual(set(stopped), set(helper.APPS.values()) - {unit})
                self.assertLess(next(i for i, call in enumerate(self.calls) if call[0] == 'stop'),
                                next(i for i, call in enumerate(self.calls) if call[0] == 'restart'))

    def test_select_requires_installed_unit(self):
        with patch.object(helper, 'installed', side_effect=lambda unit: unit == 'nanokvm.service'):
            with self.assertRaises(ValueError):
                helper.main(['select', 'jetkvm'])
        self.assertEqual(self.calls, [])

    def test_hdmi_restart_pauses_running_application(self):
        self.active = {'nanokvm.service'}
        with patch.object(helper, 'installed', return_value=True), \
             patch.object(helper.subprocess, 'run', side_effect=self.run_is_active):
            helper.main(['restart', 'vim4-kvm-hdmi.service'])
        self.assertEqual(self.calls, [('stop', 'nanokvm.service'), ('restart', 'vim4-kvm-hdmi.service'),
                                      ('start', 'nanokvm.service')])

    def hdr_config(self):
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / 'vim4-kvm-hdr'
        self.enterContext(patch.object(helper, 'HDR_CONFIG', str(path)))
        self.enterContext(patch.object(helper.os, 'sync'))
        self.applied = []
        self.enterContext(patch.object(helper.subprocess, 'run',
                                       side_effect=lambda args, **kwargs: self.applied.append(args)))
        return path

    def test_hdr_curve_applies_live_and_saves_without_restarting_capture(self):
        path = self.hdr_config()
        helper.main(['hdr-curve', '203', '1000'])
        self.assertEqual(self.applied, [[helper.HDR_CURVE, 'apply', '203', '1000']])
        self.assertEqual(path.read_text(), 'HDR_SDR_WHITE=203\nHDR_SDR_PEAK=1000\n')
        self.assertEqual(self.calls, [])

    def test_hdr_preview_does_not_save(self):
        path = self.hdr_config()
        helper.main(['hdr-preview', '180', '2000'])
        self.assertEqual(self.applied, [[helper.HDR_CURVE, 'apply', '180', '2000']])
        self.assertFalse(path.exists())

    def test_failed_apply_keeps_saved_curve(self):
        path = self.hdr_config()
        path.write_text('HDR_SDR_WHITE=250\n')
        with patch.object(helper.subprocess, 'run', side_effect=subprocess.CalledProcessError(3, 'apply')):
            with self.assertRaises(subprocess.CalledProcessError):
                helper.main(['hdr-curve', '203', '1000'])
        self.assertEqual(path.read_text(), 'HDR_SDR_WHITE=250\n')

    def test_hdr_curve_rejects_values_the_curve_tool_refuses(self):
        path = self.hdr_config()
        for action in ('hdr-curve', 'hdr-preview'):
            for white, peak in (('159', '1000'), ('1001', '2000'), ('203', '203'), ('203', '10001'),
                                ('2e2', '1000'), ('²⁰³', '1000'), ('203', '-1'), ('203', '1000\nHDMI_WIDTH=1')):
                with self.subTest(action=action, white=white, peak=peak), self.assertRaises(ValueError):
                    helper.main([action, white, peak])
        self.assertFalse(path.exists())
        self.assertEqual(self.applied, [])

    def test_unmanaged_requests_rejected(self):
        for argv in (['restart', 'vim4-kvm-gadget.service'], ['restart', 'ssh.service'], ['select', 'other'],
                     ['select'], ['enable', 'nanokvm.service'], ['hdr-curve', '203'], []):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                helper.main(argv)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
