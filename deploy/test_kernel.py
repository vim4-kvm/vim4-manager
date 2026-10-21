import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_helper import helper


class KernelSwitchTest(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.boot = SimpleNamespace(select=Mock(side_effect=lambda identifier: self.events.append('select')))
        self.enterContext(patch.dict(sys.modules, {'vim4boot': self.boot}))
        self.media = self.enterContext(patch.object(helper, 'check_pikvm_media'))
        self.services = self.enterContext(patch.object(helper, 'systemctl',
            side_effect=lambda action, *units: self.events.append(action)))
        self.enterContext(patch.object(helper.subprocess, 'run', side_effect=self.run_command))
        self.schedule_error = False

    def run_command(self, args, **kwargs):
        if args[0] == 'systemd-run':
            self.events.append('reboot')
            if self.schedule_error:
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 0)
        return subprocess.CompletedProcess(args, 0 if args[-1] == 'one-kvm.service' else 3)

    def test_reboot_stops_capture_before_selection_and_scheduling(self):
        helper.main(['kernel-select', 'mainline', 'true'])
        self.assertEqual(self.events, ['stop', 'select', 'reboot'])
        self.assertEqual(self.media.call_count, 2)

    def test_inflight_media_mount_aborts_and_restores_the_running_application(self):
        self.media.side_effect = [None, ValueError('media still mounted')]
        with self.assertRaisesRegex(ValueError, 'mounted'):
            helper.main(['kernel-select', 'mainline', 'true'])
        self.assertEqual(self.events, ['stop', 'start'])
        self.boot.select.assert_not_called()

    def test_invalid_kernel_artifact_restores_application_without_reboot(self):
        self.boot.select.side_effect = ValueError('checksum mismatch')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            helper.main(['kernel-select', 'mainline', 'true'])
        self.assertEqual(self.events, ['stop', 'start'])

    def test_scheduler_failure_is_reported_and_application_is_restored(self):
        self.schedule_error = True
        with self.assertRaises(subprocess.CalledProcessError):
            helper.main(['kernel-select', 'vendor', 'true'])
        self.assertEqual(self.events, ['stop', 'select', 'reboot', 'start'])

    def test_saving_next_boot_does_not_stop_the_application(self):
        helper.main(['kernel-select', 'vendor', 'false'])
        self.assertEqual(self.events, ['select'])
