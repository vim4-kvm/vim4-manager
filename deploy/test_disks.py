import io
import json
import os
from pathlib import Path
import shutil
import signal
import select
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

# Preload the workspace module before the helper adds its installed-module path.
# This also makes stale /usr/lib copies irrelevant in shared test VMs.
import importlib.util
spec = importlib.util.spec_from_file_location('vim4media', Path(__file__).resolve().parents[2] / 'board/vim4media.py')
source_media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_media)
sys.modules['vim4media'] = source_media
from test_helper import helper
helper.vim4media = source_media
helper.media_locks = source_media.media_locks
helper.media_image = source_media.open_image
helper.media_catalog = source_media.catalog


class DiskValidationTest(unittest.TestCase):
    def test_paths_and_labels(self):
        for path in ('relative', '/a/../b', '/a//b', '/a\\b', '/a\0b', '/a\nb', '/a*',
                     '/' + 'a/' * 16 + 'b', '/' + 'x' * 256):
            with self.subTest(path=path), self.assertRaises(ValueError):
                helper.fat_path(path)
        self.assertEqual(helper.fat_path('/长文件名 [1].txt'), '/长文件名 [1].txt')
        self.assertEqual(helper.disk_label(' DATA '), 'DATA')
        for label in ('', 'lower', 'A' * 12, 'BAD:LABEL'):
            with self.assertRaises(ValueError):
                helper.disk_label(label)


@unittest.skipUnless(sys.platform == 'linux' and shutil.which('mdir') and shutil.which('mkfs.vfat'),
                     'real FAT tests require Linux, mtools and dosfstools')
class DiskRoundTripTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.data = self.root / 'data'
        self.data.mkdir()
        self.lun = self.root / 'file'
        self.lun.write_text('')
        (self.root / 'ro').write_text('0')
        media = helper.vim4media
        for name, value in {'DATA_DIR': self.data, 'SNAPSHOT_DIR': self.root / 'snapshots',
                            'IMAGE_ROOTS': {}, 'LUN_FILE': self.lun,
                            'LOCKS': [self.root / 'lock1', self.root / 'lock2']}.items():
            self.enterContext(patch.object(media, name, value))
        self.enterContext(patch.object(helper, 'DISK_STAGING', self.root / 'staging'))
        self.enterContext(patch.object(helper, 'ALLOCATION_LOCK', self.root / 'allocation.lock'))
        # Exercise actual flock and mtools as an ordinary VM user too.
        real_stat = os.fstat

        def fixture_stat(fd):
            info = real_stat(fd)
            fields = list(info)
            fields[4] = 0
            return os.stat_result(fields)

        self.enterContext(patch.object(os, 'fstat', side_effect=fixture_stat))
        helper.disk_create('disk.img', '64', 'TEST')

    def command(self, *args):
        return helper.disk_command(list(args))

    def put(self, path, content, overwrite='0', size=None):
        with helper.vim4media.edit_disk('disk.img') as fd:
            helper.disk_put(fd, path, str(len(content) if size is None else size), overwrite, io.BytesIO(content))

    def test_real_fat_round_trip_snapshot_restore_and_delete(self):
        self.command('disk-mkdir', 'disk.img', '/文件夹')
        self.put('/文件夹/long name [1].txt', b'hello FAT')
        listing = self.command('disk-ls', 'disk.img', '/文件夹')
        self.assertEqual([(e['name'], e['size']) for e in listing['entries']], [('long name [1].txt', 9)])
        self.command('disk-mv', 'disk.img', '/文件夹/long name [1].txt', '/文件夹/renamed.txt')
        listing = self.command('disk-ls', 'disk.img', '/文件夹')
        # mren stores all-lower-case 8.3 targets of long-named entries upper case.
        self.assertEqual([e['name'].casefold() for e in listing['entries']], ['renamed.txt'])
        # Uploads and listings must agree on the clock regardless of the board zone.
        self.assertLess(abs(listing['entries'][0]['mtime'] - time.time()), 180)
        for target in ('/renamed.txt', '/missing/renamed.txt'):
            with self.assertRaisesRegex(ValueError, '同一文件夹'):
                self.command('disk-mv', 'disk.img', '/文件夹/renamed.txt', target)
        with tempfile.TemporaryFile() as output, patch.object(sys, 'stdout') as stdout:
            stdout.buffer = output
            self.command('disk-get', 'disk.img', '/文件夹/renamed.txt')
            output.seek(0)
            self.assertEqual(output.read(), b'hello FAT')
        self.command('disk-label', 'disk.img', 'RENAMED')
        info = self.command('disk-list')[0]
        self.assertEqual(info['label'], 'RENAMED')
        self.assertGreater(info['freeBytes'], 0)
        snapshot = self.command('disk-snapshot', 'disk.img')['id']
        self.command('disk-rm', 'disk.img', '/文件夹')
        self.assertEqual(self.command('disk-ls', 'disk.img', '/')['entries'], [])
        self.command('disk-format', 'disk.img', 'EMPTY')
        self.command('disk-restore', 'disk.img', snapshot)
        self.assertEqual(self.command('disk-list')[0]['label'], 'RENAMED')
        self.assertEqual(self.command('disk-ls', 'disk.img', '/')['entries'][0]['name'], '文件夹')
        self.assertTrue(self.command('disk-check', 'disk.img')['ok'])
        self.command('disk-delete', 'disk.img', '1')
        self.assertEqual(len(helper.snapshot_list('disk.img')), 1)
        self.command('disk-snapshot-delete', 'disk.img', snapshot)
        self.assertEqual(helper.snapshot_list('disk.img'), [])

    def test_upload_bounds_overwrite_and_attached_refusal(self):
        self.put('/a.txt', b'old')
        with self.assertRaisesRegex(ValueError, '已存在'):
            self.put('/a.txt', b'new')
        self.put('/a.txt', b'new', '1')
        for content, size in ((b'x', 2), (b'xx', 1)):
            with self.assertRaisesRegex(ValueError, '上传'):
                self.put('/partial.txt', content, size=size)
        self.assertEqual([x['name'] for x in self.command('disk-ls', 'disk.img', '/')['entries']], ['a.txt'])
        self.lun.write_text(str(self.data / 'disk.img'))
        self.assertTrue(self.command('disk-ls', 'disk.img', '/')['stale'])
        for args in (('disk-format', 'disk.img', 'NO'), ('disk-rm', 'disk.img', '/a.txt'),
                     ('disk-delete', 'disk.img'), ('disk-snapshot', 'disk.img'), ('disk-image', 'disk.img')):
            with self.subTest(args=args), self.assertRaisesRegex(ValueError, '安全弹出'):
                self.command(*args)

    def test_locks_space_and_creation_failure_cleanup(self):
        with helper.vim4media.edit_disk('disk.img'):
            self.assertTrue(self.command('disk-list')[0]['editing'])
            with self.assertRaisesRegex(ValueError, '正在使用'):
                self.command('disk-label', 'disk.img', 'NO')
            with helper.vim4media.media_locks():
                with self.assertRaisesRegex(ValueError, '管理面板中编辑'):
                    helper.vim4media.open_image('data/disk.img', True)
        with patch.object(helper, 'format_disk', side_effect=ValueError('failed')):
            with self.assertRaisesRegex(ValueError, 'failed'):
                helper.disk_create('failed.img', '64', 'FAIL')
        self.assertFalse((self.data / 'failed.img').exists())
        with patch.object(helper.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(1, 1, 0)):
            with self.assertRaisesRegex(ValueError, '2 GiB'):
                helper.disk_create('full.img', '64', 'FULL')
        self.assertFalse((self.data / 'full.img').exists())

    def test_snapshot_limits_and_format_failure_preserve_data(self):
        self.put('/keep.txt', b'important')
        for _ in range(3):
            self.command('disk-snapshot', 'disk.img')
        with self.assertRaisesRegex(ValueError, '最多保留 3'):
            self.command('disk-format', 'disk.img', 'NEW', '1')
        self.assertEqual(self.command('disk-ls', 'disk.img', '/')['entries'][0]['name'], 'keep.txt')
        self.command('disk-delete', 'disk.img')
        self.assertEqual(helper.snapshot_list('disk.img'), [])

    def test_create_limits_and_snapshot_validation(self):
        for size in ('63', '32769'):
            with self.assertRaises(ValueError):
                helper.disk_create('bad.img', size, 'BAD')
        for index in range(7):
            (self.data / f'fixture{index}.img').write_bytes(bytes(512))
        with self.assertRaisesRegex(ValueError, '最多创建 8'):
            helper.disk_create('ninth.img', '64', 'NO')
        with self.assertRaisesRegex(ValueError, '快照标识'):
            self.command('disk-restore', 'disk.img', '../disk.img')
        snapshot = self.command('disk-snapshot', 'disk.img')['id']
        target = helper.vim4media.SNAPSHOT_DIR / 'disk.img' / snapshot
        target.unlink()
        target.symlink_to(self.data / 'disk.img')
        with self.assertRaises(OSError):
            self.command('disk-restore', 'disk.img', snapshot)

    def test_snapshot_and_restore_interruption_preserve_original(self):
        self.put('/keep.txt', b'original')
        original = (self.data / 'disk.img').read_bytes()

        def interrupted_copy(source, target):
            os.write(target, b'partial')
            self.assertEqual(helper.snapshot_list('disk.img'), [])
            raise InterruptedError('cancelled')

        with patch.object(helper, 'copy_image', side_effect=interrupted_copy):
            with self.assertRaises(InterruptedError):
                self.command('disk-snapshot', 'disk.img')
        self.assertEqual(helper.snapshot_list('disk.img'), [])
        snapshot = self.command('disk-snapshot', 'disk.img')['id']
        with patch.object(helper, 'copy_image', side_effect=InterruptedError('cancelled')):
            with self.assertRaises(InterruptedError):
                self.command('disk-restore', 'disk.img', snapshot)
        self.assertEqual((self.data / 'disk.img').read_bytes(), original)
        self.assertFalse(list(self.data.glob('.pending-*')))

    def test_killed_copy_never_publishes_partial_snapshot_or_restore(self):
        original = (self.data / 'disk.img').read_bytes()
        snapshot = self.command('disk-snapshot', 'disk.img')['id']
        for command in (('disk-snapshot', 'disk.img'), ('disk-restore', 'disk.img', snapshot)):
            ready, notify = os.pipe()
            pid = os.fork()
            if pid == 0:
                os.close(ready)

                def pause_copy(source, target):
                    os.write(target, b'partial copy')
                    os.write(notify, b'1')
                    signal.pause()

                helper.copy_image = pause_copy
                try:
                    self.command(*command)
                finally:
                    os._exit(1)
            os.close(notify)
            try:
                readable, _, _ = select.select([ready], [], [], 10)
                self.assertTrue(readable, 'child did not reach copy')
                self.assertEqual(os.read(ready, 1), b'1')
            finally:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                os.close(ready)
            self.assertEqual([s['id'] for s in helper.snapshot_list('disk.img')], [snapshot])
            self.assertEqual((self.data / 'disk.img').read_bytes(), original)
            # Abrupt death may leave hidden staging files, but never a usable
            # partial image; all locks are released by the kernel.
            with helper.vim4media.edit_disk('disk.img'):
                pass

    def test_resize_preserves_files_label_and_old_snapshot(self):
        self.command('disk-mkdir', 'disk.img', '/空文件夹')
        self.command('disk-mkdir', 'disk.img', '/目录')
        self.put('/目录/long [1].txt', b'\x00\xffimportant')
        self.put('/hidden.txt', b'hidden')
        with helper.vim4media.edit_disk('disk.img') as fd:
            helper.disk_tool(fd, 'mattrib', '+h', '+s', '::/hidden.txt')
        old = (self.data / 'disk.img').read_bytes()
        result = self.command('disk-resize', 'disk.img', '96')
        self.assertTrue(result['ok'])
        snapshot = helper.vim4media.SNAPSHOT_DIR / 'disk.img' / result['snapshot']
        self.assertEqual(snapshot.read_bytes(), old)
        self.assertEqual((self.data / 'disk.img').stat().st_size, 96 << 20)
        self.assertEqual(self.command('disk-list')[0]['label'], 'TEST')
        self.assertEqual({e['name'] for e in self.command('disk-ls', 'disk.img', '/')['entries']},
                         {'空文件夹', '目录', 'hidden.txt'})
        with helper.vim4media.read_disk('disk.img') as (fd, _):
            self.assertEqual(helper.disk_tool(fd, 'mtype', helper.fat_arg('/目录/long [1].txt')).stdout,
                             b'\x00\xffimportant')
            self.assertEqual(helper.disk_tool(fd, 'mtype', '::/hidden.txt').stdout, b'hidden')
            attributes = helper.disk_tool(fd, 'mattrib', '::/hidden.txt').stdout.decode()
            self.assertIn('H', attributes)
            self.assertIn('S', attributes)
        self.assertTrue(self.command('disk-check', 'disk.img')['ok'])
        self.command('disk-restore', 'disk.img', result['snapshot'])
        self.assertEqual((self.data / 'disk.img').read_bytes(), old)

    def test_resize_legacy_nanokvm_label(self):
        with helper.vim4media.edit_disk('disk.img') as fd:
            subprocess.run(['mkfs.vfat', '-F', '32', '-n', 'Vim4KVM', f'/proc/self/fd/{fd}'],
                           pass_fds=(fd,), check=True, capture_output=True)
        self.put('/keep.txt', b'legacy content')
        self.command('disk-resize', 'disk.img', '80')
        self.assertEqual(self.command('disk-list')[0]['label'], 'Vim4KVM')
        with helper.vim4media.read_disk('disk.img') as (fd, _):
            self.assertEqual(helper.disk_tool(fd, 'mtype', '::/keep.txt').stdout, b'legacy content')

    def test_resize_empty_unlabelled_and_copy_or_fsck_failure(self):
        with helper.vim4media.edit_disk('disk.img') as fd:
            helper.disk_tool(fd, 'mlabel', '-c', '::')
        self.command('disk-resize', 'disk.img', '80')
        self.assertEqual(self.command('disk-list')[0]['label'], '')
        self.put('/keep.txt', b'keep')
        original = (self.data / 'disk.img').read_bytes()
        run = helper.subprocess.run

        def fail_copy(args, **kwargs):
            if args[0] == 'mcopy':
                return subprocess.CompletedProcess(args, 1, b'', b'copy failed')
            return run(args, **kwargs)

        with patch.object(helper.subprocess, 'run', side_effect=fail_copy):
            with self.assertRaisesRegex(ValueError, 'copy failed'):
                self.command('disk-resize', 'disk.img', '96')
        with patch.object(helper, 'check_fat', side_effect=[None, ValueError('fsck failed')]):
            with self.assertRaisesRegex(ValueError, 'fsck failed'):
                self.command('disk-resize', 'disk.img', '96')
        with patch.object(helper.shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(1, 1, 0)):
            with self.assertRaisesRegex(ValueError, '2 GiB'):
                self.command('disk-resize', 'disk.img', '96')
        self.assertEqual((self.data / 'disk.img').read_bytes(), original)
        self.assertEqual(len(helper.snapshot_list('disk.img')), 1)
        self.assertFalse(list(self.data.glob('.pending-*')))

    def test_resize_refuses_invalid_busy_unknown_and_preserves_on_failure(self):
        original = (self.data / 'disk.img').read_bytes()
        for size in ('63', '64', '32769'):
            with self.assertRaises(ValueError):
                self.command('disk-resize', 'disk.img', size)
        with helper.vim4media.read_disk('disk.img'):
            with self.assertRaisesRegex(ValueError, '正在使用'):
                self.command('disk-resize', 'disk.img', '96')
        for backing in (str(self.data / 'disk.img'), str(self.root / 'missing.img')):
            self.lun.write_text(backing)
            with self.assertRaises((ValueError, OSError)):
                self.command('disk-resize', 'disk.img', '96')
        self.lun.write_text('')
        with patch.object(helper, 'snapshot_disk', side_effect=InterruptedError('cancelled')):
            with self.assertRaises(InterruptedError):
                self.command('disk-resize', 'disk.img', '96')
        self.assertEqual((self.data / 'disk.img').read_bytes(), original)
        self.assertFalse(list(self.data.glob('.pending-*')))

    def test_readonly_image_export_and_atomic_snapshot_format(self):
        self.lun.write_text(str(self.data / 'disk.img'))
        (self.root / 'ro').write_text('1')
        with tempfile.TemporaryFile() as output, patch.object(sys, 'stdout') as stdout:
            stdout.buffer = output
            self.command('disk-image', 'disk.img')
            self.assertEqual(output.tell(), 64 << 20)
        self.lun.write_text('')
        self.put('/keep.txt', b'important')
        self.command('disk-format', 'disk.img', 'NEW', '1')
        self.assertEqual(self.command('disk-ls', 'disk.img', '/')['entries'], [])
        snapshot = helper.snapshot_list('disk.img')[0]['id']
        self.command('disk-restore', 'disk.img', snapshot)
        self.assertEqual(self.command('disk-ls', 'disk.img', '/')['entries'][0]['name'], 'keep.txt')
