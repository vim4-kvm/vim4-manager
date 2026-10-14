import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('helper', str(Path(__file__).with_name('vim4-manager-helper')))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class HelperTest(unittest.TestCase):
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

    def test_unmanaged_requests_rejected(self):
        for argv in (['restart', 'vim4-kvm-gadget.service'], ['restart', 'ssh.service'], ['select', 'other'],
                     ['select'], ['enable', 'nanokvm.service'], []):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                helper.main(argv)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
