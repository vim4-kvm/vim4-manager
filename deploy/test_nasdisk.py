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


if __name__ == '__main__':
    unittest.main()
