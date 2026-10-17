import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch, Mock

from test_helper import helper


def request(**changes):
    return dict(dict(name='NAS', type='smb', server='nas.local', share='share/sub',
                     username='khadas', domain='', password='secret', version='auto', autoMount=False), **changes)


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in ('NAS_CONFIG', 'NAS_ROOT', 'NAS_RUNTIME', 'NAS_TEST', 'NAS_UNITS'):
            self.enterContext(patch.object(helper, name, self.root / name))
        self.commands = []

        def run(args, timeout=35):
            self.commands.append(args)
            if args[0] == 'systemd-escape':
                return 'var-lib-vim4\\x2dkvm-nas-' + Path(args[-1]).name + '.mount'
            if args[:2] == ['systemctl', 'show']:
                return 'ActiveState=inactive\nResult=success'
            return ''

        self.run = self.enterContext(patch.object(helper, 'storage_run', side_effect=run))
        self.mounted = self.enterContext(patch.object(helper, 'storage_mounted', return_value=False))
        self.busy = self.enterContext(patch.object(helper, 'storage_busy', return_value=False))

    def test_validation_injections(self):
        for key, values in {
            'type': [[], {}, 'cifs'],
            'server': ['host,vers=1', 'host\nOptions=x', 'a b', 'a..b', '-host', 'fe80::1%eth0', '[::1]', 'a\\b'],
            'share': ['share/../x', 'share//x', 'share/./x', 'share\\x', ' share', 'share/x ', 'share\tx', '%n', '/smb', 'a:b', 'a*'],
            'username': ['a,password=x', 'a\nb', 'a\\b', '..', ' a', '%n', 'a=b'],
            'domain': ['a,b', 'a=b', 'a\rb', '..'],
            'password': ['a\nb', 'a\rb', 'a\0b'],
            'version': ['3.0,uid=root', '5', ''],
            'id': ['../x', '-x', 'A', 'x' * 33],
            'autoMount': ['false', 1],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    helper.storage_validate(request(**{key: value}))
        helper.storage_validate(request(password='a, b=\\%secret'))
        for share in ('公共 资料', '公共 资料/录像 2026', 'Public Data'):
            helper.storage_validate(request(share=share))
        helper.storage_validate(request(type='nfs', share='/volume1/影音 库'))
        helper.storage_validate(request(username='张 三'))
        for server in ('192.168.1.1', 'nas.local', '2001:db8::1', '::1'):
            helper.storage_validate(request(server=server))
        with self.assertRaises(ValueError):
            helper.storage_validate(request(type='nfs', share='relative'))

    def test_options_versions_ipv6_and_unit(self):
        for kind, versions in helper.NAS_VERSIONS.items():
            for version in versions:
                config = helper.storage_validate(request(id='test', type=kind, version=version,
                                                         server='2001:db8::1', share='share/sub' if kind == 'smb' else '/export/sub'))
                text = helper.storage_unit(config)
                self.assertIn('WantedBy=remote-fs.target', text)
                self.assertIn('TimeoutSec=30', text)
                self.assertIn('x-systemd.mount-timeout=30', text)
                self.assertIn('//[2001:db8::1]/share/sub' if kind == 'smb' else '[2001:db8::1]:/export/sub', text)
                option = 'vers=' if kind == 'smb' else 'nfsvers='
                if version == 'auto':
                    self.assertNotIn(option, text)
                else:
                    self.assertIn(option + version, text)
                if kind == 'smb':
                    self.assertIn('forceuid,forcegid,file_mode=0660,dir_mode=0770,soft,echo_interval=10,serverino,iocharset=utf8', text)
                else:
                    self.assertIn('soft,timeo=150,retrans=3', text)
                self.assertNotIn('secret', text)

    def test_mount_cifs_errors_are_translated(self):
        for text, message in (('mount error(113): could not connect to 10.0.0.9', '主机不可达'),
                              ('mount error(13): Permission denied', '权限被拒'),
                              ('mount error(2): No such file or directory', '共享不存在'),
                              ('mount error(95): Operation not supported', '协议版本不匹配')):
            with self.subTest(text=text):
                self.assertEqual(helper.storage_error(text), message)

    def test_guest_smb_uses_no_credentials_file(self):
        config = helper.storage_validate(request(id='guest', username='', password=''))
        self.assertIsNone(helper.storage_credentials(config, {}))
        options = helper.storage_options(config, helper.NAS_CONFIG / 'guest.cred')
        self.assertTrue(options.startswith('guest,uid=khadas'))
        self.assertNotIn('credentials=', options)

    def test_failed_unit_reports_readable_error(self):
        config = helper.storage_validate(request(id='nas'))
        for result, text in (('exit-code', '测试连接'), ('timeout', '超时')):
            with self.subTest(result=result), patch.object(
                    helper, 'storage_run', side_effect=lambda args, timeout=35: (
                        'x.mount' if args[0] == 'systemd-escape' else f'ActiveState=failed\nResult={result}')):
                status = helper.storage_status(config)
                self.assertEqual(status['state'], 'error')
                self.assertIn(text, status['error'])
                self.assertNotIn(result, status['error'])

    def test_save_credentials_update_and_limit(self):
        saved = helper.storage_save(request())
        identifier = saved['id']
        cred = helper.NAS_CONFIG / (identifier + '.cred')
        config = helper.NAS_CONFIG / (identifier + '.json')
        self.assertEqual(cred.stat().st_mode & 0o777, 0o600)
        self.assertEqual(config.stat().st_mode & 0o777, 0o644)
        self.assertEqual(helper.NAS_CONFIG.stat().st_mode & 0o777, 0o755)
        self.assertNotIn('password', config.read_text())
        self.assertNotIn('secret', json.dumps(saved))
        changed = request(id=identifier, username='new')
        del changed['password']
        helper.storage_save(changed)
        self.assertIn('username=new\npassword=secret', cred.read_text())
        helper.storage_save(request(id=identifier, password=''))
        self.assertIn('password=\n', cred.read_text())
        with self.assertRaises(ValueError):
            helper.storage_save(request(id=identifier, type='nfs', share='/export'))
        for _ in range(7):
            helper.storage_save(request())
        with self.assertRaisesRegex(ValueError, '8'):
            helper.storage_save(request())
        helper.storage_save(request(id=identifier))
        self.assertNotIn('secret', str(self.commands))

    def test_auto_mount_and_remount(self):
        with patch.object(helper, 'storage_detect_write') as probe:
            saved = helper.storage_save(request(autoMount=True))
            self.assertTrue(any(cmd[:2] == ['systemctl', 'enable'] for cmd in self.commands))
            probe.assert_called_once()
            self.mounted.return_value = True
            with patch.object(helper, 'storage_unmount') as unmount:
                helper.storage_save(request(id=saved['id'], autoMount=False))
                unmount.assert_called_once()
            self.assertEqual(probe.call_count, 2)

    def test_busy_delete_and_confirmation(self):
        saved = helper.storage_save(request())
        identifier = saved['id']
        self.busy.return_value = True
        with self.assertRaisesRegex(ValueError, 'USB'):
            helper.storage_unmount(saved)
        self.assertFalse(any(cmd[:2] == ['systemctl', 'stop'] for cmd in self.commands))
        with patch.object(helper.sys, 'stdin', io.StringIO('{"confirm":"wrong"}')), self.assertRaises(ValueError):
            helper.storage_command(['storage-delete', identifier])
        self.busy.return_value = False
        # Never recursively erase a local file that landed in an unmounted directory.
        local = helper.NAS_ROOT / identifier / 'keep'
        local.write_text('data')
        with patch.object(helper.sys, 'stdin', io.StringIO('{"confirm":"NAS"}')), self.assertRaises(OSError):
            helper.storage_command(['storage-delete', identifier])
        self.assertEqual(local.read_text(), 'data')
        local.unlink()
        with patch.object(helper.sys, 'stdin', io.StringIO('{"confirm":"NAS"}')):
            self.assertTrue(helper.storage_command(['storage-delete', identifier])['ok'])
        self.assertFalse((helper.NAS_CONFIG / (identifier + '.json')).exists())
        self.assertFalse((helper.NAS_CONFIG / (identifier + '.cred')).exists())
        self.assertFalse((helper.NAS_ROOT / identifier).exists())

    def test_status_timeout_and_insecure(self):
        config = helper.storage_validate(request(id='test', version='1.0'))
        self.mounted.return_value = True
        with patch.object(helper, 'storage_bounded', side_effect=[TimeoutError(), False]):
            result = helper.storage_status(config)
        self.assertTrue(result['mounted'])
        self.assertTrue(result['insecure'])
        self.assertTrue(result['stale'])
        self.assertIsNone(result['totalBytes'])
        self.mounted.return_value = False
        with patch.object(helper, 'storage_capacity') as capacity:
            self.assertFalse(helper.storage_status(config)['mounted'])
            capacity.assert_not_called()

    def test_test_cleanup_and_secret_not_in_arguments(self):
        capacity = dict(totalBytes=123, freeBytes=45, writable=False)
        self.mounted.return_value = True
        with patch.object(helper, 'storage_bounded', return_value=capacity):
            result = helper.storage_test(request())
        self.assertTrue(result['ok'])
        self.assertFalse(result['writable'])
        self.assertIn('权限被拒', result['error'])
        self.assertEqual(list(helper.NAS_TEST.iterdir()), [])
        self.assertNotIn('secret', str(self.commands))
        self.assertTrue(any(cmd[0] == 'umount' for cmd in self.commands))
        mount = next(cmd for cmd in self.commands if cmd[0] == 'mount')
        self.assertNotIn('nofail', mount[mount.index('-o') + 1], 'nofail hides direct mount failures')
        with patch.object(helper, 'storage_bounded', side_effect=TimeoutError('timeout')):
            result = helper.storage_test(request())
        self.assertFalse(result['ok'])
        self.assertIn('超时', result['error'])
        self.assertEqual(list(helper.NAS_TEST.iterdir()), [])

    def test_failed_cleanup_preserves_mount_contents(self):
        def run(args, timeout=35):
            if args[0] == 'mount':
                (Path(args[-1]) / 'NAS-data').write_text('keep')
            if args[0] == 'umount':
                raise ValueError('网络存储操作超时')
            return ''
        self.run.side_effect = run
        self.mounted.return_value = True
        with patch.object(helper, 'storage_bounded', return_value=dict(totalBytes=1, freeBytes=1, writable=True)):
            result = helper.storage_test(request())
        self.assertFalse(result['ok'])
        self.assertEqual(next(helper.NAS_TEST.glob('*/mount/NAS-data')).read_text(), 'keep')
        self.assertEqual(list(helper.NAS_TEST.glob('*/credentials')), [])

    def test_dirs_no_symlinks_and_limits(self):
        config = helper.storage_validate(request(id='test'))
        root = helper.NAS_ROOT / 'test'
        root.mkdir(parents=True)
        (root / 'z').mkdir()
        (root / 'a').mkdir()
        (root / 'file').write_text('x')
        (root / 'escape').symlink_to(self.root, target_is_directory=True)
        self.mounted.return_value = True
        self.assertEqual(helper.storage_dirs(config, '/')['entries'], [{'name': 'a'}, {'name': 'z'}])
        for path in ('/escape', '/a/../z', '//a', 'relative'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                helper.storage_dirs(config, path)
        for index in range(501):
            (root / str(index)).mkdir()
        result = helper.storage_dirs(config, '/')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['entries']), 500)
        self.assertEqual(result['entries'], sorted(result['entries'], key=lambda entry: entry['name']))

    def test_worker_timeout_is_bounded(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            helper.storage_bounded(lambda: time.sleep(30), .05)
        self.assertLess(time.monotonic() - started, 1)

    def test_command_timeout_does_not_wait_forever(self):
        process = Mock()
        process.communicate.side_effect = subprocess.TimeoutExpired('mount', 1)
        # Exercise the original function while other tests use the command stub.
        with patch.object(helper.subprocess, 'Popen', return_value=process), patch.object(helper.os, 'killpg') as kill:
            with self.assertRaisesRegex(ValueError, '超时'):
                self.real_run(['mount'], .01)
            kill.assert_called_once_with(process.pid, helper.signal.SIGKILL)
        self.assertEqual(process.communicate.call_count, 2)

    def test_storage_lock_is_separate_and_readers_do_not_lock(self):
        with patch.object(helper.os, 'open', return_value=42) as opened, patch.object(helper.os, 'close'), \
                patch.object(helper.fcntl, 'flock') as flock:
            for action in ('storage-list', 'storage-dirs'):
                with helper.operation_lock([action]):
                    pass
            opened.assert_not_called()
            for action in ('storage-save', 'storage-test', 'storage-mount', 'storage-unmount', 'storage-delete'):
                with helper.operation_lock([action]):
                    pass
            self.assertEqual(flock.call_count, 5)
            self.assertTrue(all(call.args[0] == '/run/lock/vim4-manager-storage.lock' for call in opened.call_args_list))

    def test_busy_checks_usb_and_process_paths(self):
        root = helper.NAS_ROOT / 'test'
        sysfs, proc = self.root / 'sysfs', self.root / 'proc'
        lun = sysfs / 'g/functions/mass_storage.disk/lun.0/file'
        lun.parent.mkdir(parents=True)
        lun.write_text(str(root / 'image.img'))
        real_path = Path
        def path(value):
            return {'/sys/kernel/config/usb_gadget': sysfs, '/proc': proc}.get(value, real_path(value))
        with patch.object(helper, 'Path', side_effect=path):
            self.assertTrue(self.real_busy(root))
            lun.write_text(str(root) + '-other/image.img')
            self.assertFalse(self.real_busy(root))
            fd = proc / '123/fd/4'
            fd.parent.mkdir(parents=True)
            fd.symlink_to(root / 'recording.mkv')
            self.assertTrue(self.real_busy(root))

    def test_mountinfo_not_directory_existence(self):
        with patch.object(Path, 'read_text', return_value='1 2 0:3 / /nas\\040drive rw - cifs //host/share rw\n'):
            self.assertTrue(self.real_mounted(Path('/nas drive')))
            self.assertFalse(self.real_mounted(self.root))

    real_run = staticmethod(helper.storage_run)
    real_busy = staticmethod(helper.storage_busy)
    real_mounted = staticmethod(helper.storage_mounted)


if __name__ == '__main__':
    unittest.main()
