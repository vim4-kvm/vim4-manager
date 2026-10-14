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
        self.assertEqual(self.calls, [('disable', 'nanokvm.service'), ('enable', 'vim4-kvm.service'),
                                      ('stop', 'nanokvm.service'),
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
        self.assertEqual(self.calls, [('stop', 'vim4-kvm.service'), ('restart', 'nanokvm.service')])

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

    def hdr_config(self, content=None):
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / 'vim4-kvm-hdr'
        if content is not None:
            path.write_text(content)
        self.enterContext(patch.object(helper, 'HDR_CONFIG', str(path)))
        self.enterContext(patch.object(helper.os, 'sync'))
        return path

    def test_hdr_curve_writes_config_and_restarts_capture(self):
        path = self.hdr_config()
        self.active = {'vim4-kvm.service'}
        with patch.object(helper, 'installed', return_value=True), \
             patch.object(helper.subprocess, 'run', side_effect=self.run_is_active):
            helper.main(['hdr-curve', '203', '1000'])
        self.assertEqual(path.read_text(), 'HDR_SDR_WHITE=203\nHDR_SDR_PEAK=1000\n')
        self.assertEqual(self.calls, [('stop', 'vim4-kvm.service'), ('restart', 'vim4-kvm-hdmi.service'),
                                      ('start', 'vim4-kvm.service')])

    def test_hdr_curve_restores_previous_config_when_capture_fails(self):
        path = self.hdr_config('HDR_SDR_WHITE=250\n')
        self.active = {'nanokvm.service'}
        failed = []

        def fail_first_restart(*args):
            self.calls.append(args)
            if args[0] == 'restart' and not failed:
                failed.append(path.read_text())
                raise subprocess.CalledProcessError(1, 'systemctl')
        with patch.object(helper, 'installed', return_value=True), \
             patch.object(helper.subprocess, 'run', side_effect=self.run_is_active), \
             patch.object(helper, 'systemctl', side_effect=fail_first_restart):
            with self.assertRaises(subprocess.CalledProcessError):
                helper.main(['hdr-curve', '300', '2000'])
        self.assertEqual(failed, ['HDR_SDR_WHITE=300\nHDR_SDR_PEAK=2000\n'])
        self.assertEqual(path.read_text(), 'HDR_SDR_WHITE=250\n')
        self.assertEqual(self.calls[-3:], [('reset-failed', 'vim4-kvm-hdmi.service'),
                                           ('restart', 'vim4-kvm-hdmi.service'), ('start', 'nanokvm.service')])

    def test_hdr_curve_rejects_values_hdmi_setup_refuses(self):
        path = self.hdr_config()
        for white, peak in (('79', '1000'), ('1001', '2000'), ('203', '203'), ('203', '10001'),
                            ('2e2', '1000'), ('²⁰³', '1000'), ('203', '-1'), ('203', '1000\nHDMI_WIDTH=1')):
            with self.subTest(white=white, peak=peak), self.assertRaises(ValueError):
                helper.main(['hdr-curve', white, peak])
        self.assertFalse(path.exists())
        self.assertEqual(self.calls, [])

    def test_unmanaged_requests_rejected(self):
        for argv in (['restart', 'vim4-kvm-gadget.service'], ['restart', 'ssh.service'], ['select', 'other'],
                     ['select'], ['enable', 'nanokvm.service'], ['hdr-curve', '203'], []):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                helper.main(argv)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
