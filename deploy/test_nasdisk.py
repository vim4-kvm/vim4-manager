import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from test_helper import helper


class NASDiskTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        for name in ('NAS_ROOT', 'NAS_CONFIG', 'NASDISK_RUNTIME'):
            target = self.root / name
            target.mkdir()
            self.enterContext(patch.object(helper, name, target))
        self.mount = helper.NAS_ROOT / 'nas'
        self.mount.mkdir()
        self.config = dict(id='nas', name='NAS')
        self.enterContext(patch.object(helper, 'storage_load', return_value=self.config))
        self.enterContext(patch.object(helper, 'storage_mounted', return_value=True))
        self.enterContext(patch.object(helper, 'storage_bounded', side_effect=lambda fn, timeout: fn()))
        self.active = self.enterContext(patch.object(helper, 'nasdisk_active', return_value=False))
        self.cleanup = self.enterContext(patch.object(helper, 'nasdisk_cleanup_mount'))
        self.lun = self.root / 'lun'
        self.lun.write_text('')
        self.enterContext(patch.object(helper, 'PIKVM_LUN_FILE', self.lun))

    def test_directory_validation_and_symlinks(self):
        (self.mount / 'folder').mkdir()
        (self.mount / 'link').symlink_to('folder')
        self.assertEqual(helper.nasdisk_folder(self.config, '/folder'), str(self.mount / 'folder'))
        for name in ('../folder', '/..', '//folder', '/folder/', '/.vim4-nasdisk', '/folder/../folder', '/link'):
            with self.subTest(name=name), self.assertRaises((ValueError, OSError)):
                helper.nasdisk_folder(self.config, name)

    def test_start_holds_media_lock_and_refuses_occupied_lun(self):
        locked = False
        @contextmanager
        def lock():
            nonlocal locked
            locked = True
            try:
                yield
            finally:
                locked = False
        def run(args, timeout):
            self.assertTrue(locked)
            self.assertEqual(args, ['systemctl', 'start', 'vim4-nasdisk.service'])
            return ''
        request = dict(storage='nas', path='/', mode='rw', label='FILES')
        with patch.object(helper, 'storage_read_request', return_value=request), patch.object(helper, 'media_locks', lock), patch.object(helper, 'storage_run', side_effect=run):
            answer = helper.nasdisk_command(['nasdisk-start'])
            self.assertTrue(answer['ok'])
            session = helper.nasdisk_read('session.json')
            self.assertEqual(session['root'], str(self.mount))
            self.lun.write_text('/other.img')
            with self.assertRaisesRegex(ValueError, '已有虚拟磁盘'):
                helper.nasdisk_command(['nasdisk-start'])

    def test_discard_requires_matching_confirmation(self):
        identifier = 'a' * 32
        with patch.object(helper, 'storage_read_request', return_value={'confirm': 'wrong'}):
            with self.assertRaisesRegex(ValueError, '确认'):
                helper.nasdisk_command(['nasdisk-discard', identifier])

    def test_status_merges_pending_and_timeout_is_unknown(self):
        identifier = 'a' * 32
        status = dict(id=identifier, state='attached')
        (helper.NASDISK_RUNTIME / 'status.json').write_text(json.dumps(status))
        (helper.NASDISK_RUNTIME / 'last.json').write_text(json.dumps(dict(id='previous')))
        self.active.return_value = True
        with patch.object(helper, 'nasdisk_pending', return_value=[dict(id=identifier), dict(id='b' * 32)]):
            answer = helper.nasdisk_command(['nasdisk-status'])
            self.assertEqual(answer['session'], status)
            self.assertEqual(answer['last']['id'], 'previous')
            self.assertEqual(len(answer['pending']), 1)
        with patch.object(helper, 'nasdisk_pending', side_effect=TimeoutError('timeout')):
            answer = helper.nasdisk_command(['nasdisk-status'])
            self.assertFalse(answer['known'])
            self.assertEqual(answer['session'], status)

    def test_jetkvm_writable_rejected_before_open(self):
        identifier = 'a' * 32
        (helper.NASDISK_RUNTIME / 'session.json').write_text(json.dumps(dict(id=identifier, mode='rw')))
        self.active.return_value = True
        @contextmanager
        def lock():
            yield
        with patch.object(helper, 'media_locks', lock), patch.object(helper, 'media_active'), patch.object(helper, 'storage_run', side_effect=lambda args, timeout: 'active' if args[-1] == helper.APPS['jetkvm'] else 'inactive'):
            with self.assertRaisesRegex(ValueError, 'JetKVM'):
                helper.nasdisk_command(['nasdisk-lun-attach', identifier])

    def trash_fixture(self):
        identifier = 'a' * 32
        last = dict(id=identifier, storage='nas', path='/folder')
        (helper.NASDISK_RUNTIME / 'last.json').write_text(json.dumps(last))
        trash = self.mount / 'folder/.vim4-nasdisk/trash'
        (trash / identifier / 'sub').mkdir(parents=True)
        (trash / identifier / 'sub/file').write_bytes(b'12345')
        (trash / 'older').mkdir()
        (trash / 'older/file').write_bytes(b'abc')
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        (trash / 'escape').symlink_to(outside, target_is_directory=True)
        return last, trash, outside

    def test_trash_counts_folder_history_and_empty_never_follows_symlinks(self):
        last, trash, outside = self.trash_fixture()
        with patch.object(helper, 'nasdisk_pending', return_value=[]):
            answer = helper.nasdisk_command(['nasdisk-status'])
        self.assertEqual(answer['last']['trash'], dict(bytes=8, files=2))
        with patch.object(helper, 'storage_read_request', return_value=dict(id=last['id'], confirm=last['id'])):
            result = helper.nasdisk_command(['nasdisk-trash-empty'])
        self.assertEqual(result, dict(ok=True, trash=dict(bytes=0, files=0)))
        self.assertEqual(list(trash.iterdir()), [])
        self.assertEqual((outside / 'keep').read_text(), 'keep')
        self.assertEqual(helper.nasdisk_read('last.json')['trash'], dict(bytes=0, files=0))

    def test_trash_confirmation_active_session_unmounted_and_timeout(self):
        last, trash, _ = self.trash_fixture()
        for request in (dict(id='b' * 32, confirm='b' * 32), dict(id=last['id'], confirm='wrong')):
            with self.assertRaises(ValueError):
                helper.nasdisk_trash_empty(request)
        request = dict(id=last['id'], confirm=last['id'])
        self.active.return_value = True
        with self.assertRaisesRegex(ValueError, '运行中'):
            helper.nasdisk_trash_empty(request)
        self.active.return_value = False
        with patch.object(helper, 'storage_mounted', return_value=False), patch.object(helper, 'nasdisk_pending', return_value=[]):
            self.assertIsNone(helper.nasdisk_command(['nasdisk-status'])['last']['trash'])
            with self.assertRaisesRegex(ValueError, '尚未挂载'):
                helper.nasdisk_trash_empty(request)
        with patch.object(helper, 'storage_bounded', side_effect=TimeoutError('超时')), patch.object(helper, 'nasdisk_pending', return_value=[]):
            self.assertIsNone(helper.nasdisk_command(['nasdisk-status'])['last']['trash'])
            with self.assertRaises(TimeoutError):
                helper.nasdisk_trash_empty(request)
        self.assertTrue((trash / last['id'] / 'sub/file').exists())

    def test_trash_root_and_parent_symlinks_are_rejected(self):
        last, trash, outside = self.trash_fixture()
        trash.rename(trash.with_name('saved'))
        trash.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            helper.nasdisk_trash(last, empty=True)
        self.assertEqual((outside / 'keep').read_text(), 'keep')
        (self.mount / 'folder').rename(self.mount / 'saved-folder')
        (self.mount / 'folder').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            helper.nasdisk_trash(last, empty=True)

    def test_stale_mount_aborts_before_lazy_unmount_without_stat(self):
        mountinfo = f'1 2 0:73 / {helper.NASDISK_RUNTIME}/fs rw - fuse.nasdisk vim4-nasdisk rw\n'
        events = []
        with patch.object(Path, 'read_text', return_value=mountinfo), patch.object(Path, 'write_text', side_effect=lambda text: events.append(('abort', text))), patch.object(helper, 'storage_run', side_effect=lambda args, timeout: events.append(('unmount', args))):
            # setUp replaces cleanup for portable start tests; call the original here.
            self.real_cleanup()
        self.assertEqual(events, [('abort', '1\n'), ('unmount', ['umount', '-l', str(helper.NASDISK_RUNTIME / 'fs')])])

    real_cleanup = staticmethod(helper.nasdisk_cleanup_mount)


if __name__ == '__main__':
    unittest.main()
