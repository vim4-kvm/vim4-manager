import errno
import os
from pathlib import Path
import tempfile
import unittest
from contextlib import nullcontext
from unittest.mock import patch

from test_helper import helper


class MediaManagementTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.images = self.root / 'images'
        self.images.mkdir()
        (self.images / 'disk.img').write_bytes(bytes(1024))
        self.gadget = self.root / 'gadget'
        self.lun = self.gadget / 'functions/mass_storage.disk0/lun.0'
        self.lun.mkdir(parents=True)
        self.config = self.gadget / 'configs/c.1'
        self.config.mkdir(parents=True)
        for key, value in {'file': '', 'ro': '0', 'cdrom': '0'}.items():
            (self.lun / key).write_text(value)
        (self.gadget / 'UDC').write_text('controller')
        for name in ('hid.keyboard', 'hid.mouse_abs', 'hid.mouse_rel', 'ncm.usb0'):
            self.link(name)
        self.enterContext(patch.object(helper.vim4media, 'IMAGE_ROOTS', {'shared': self.images}))
        self.enterContext(patch.object(helper.vim4media, 'DATA_DIR', self.root / 'absent'))
        self.enterContext(patch.object(helper, 'PIKVM_LUN_FILE', self.lun / 'file'))
        self.enterContext(patch.object(helper, 'media_locks', side_effect=nullcontext))
        self.enterContext(patch.object(helper, 'media_active'))
        self.enterContext(patch.object(helper.time, 'sleep'))

    def link(self, name):
        (self.config / name).symlink_to(self.gadget / 'functions' / name)

    def test_catalog_and_open_reject_links_traversal_and_special_files(self):
        (self.images / 'outside.img').symlink_to(self.images / 'disk.img')
        (self.images / 'linked-dir').symlink_to(self.images, target_is_directory=True)
        os.mkfifo(self.images / 'pipe.img')
        (self.images / 'nested').mkdir()
        (self.images / 'nested/rescue.iso').write_bytes(bytes(2048))
        (self.images / 'small.img').write_bytes(b'x')
        self.assertEqual([image['id'] for image in helper.media_catalog()],
                         ['shared/disk.img', 'shared/nested/rescue.iso'])
        for identifier in ('shared/../disk.img', 'shared//disk.img', '/etc/passwd',
                           'shared/outside.img', 'shared/linked-dir/disk.img',
                           'shared/pipe.img', 'shared/small.img'):
            with self.subTest(identifier=identifier), self.assertRaises((ValueError, OSError)):
                helper.media_image(identifier, True)
        os.link(self.images / 'disk.img', self.images / 'hard.img')
        with self.assertRaises(ValueError):
            helper.media_image('shared/disk.img', True)

    def test_existing_medium_is_never_replaced(self):
        (self.lun / 'file').write_text('/existing.img')
        with self.assertRaisesRegex(ValueError, '不会替换'):
            helper.media_mount('nanokvm', 'shared/disk.img', False, True)
        self.assertEqual((self.gadget / 'UDC').read_text(), 'controller')
        self.assertEqual((self.lun / 'file').read_text(), '/existing.img')

    def test_stock_profile_mount_preserves_hid_and_replaces_network(self):
        helper.media_mount('nanokvm', 'shared/disk.img', False, False)
        self.assertEqual((self.lun / 'ro').read_text(), '0')
        self.assertTrue((self.config / 'mass_storage.disk0').is_symlink())
        self.assertFalse((self.config / 'ncm.usb0').is_symlink())
        self.assertTrue((self.config / 'hid.keyboard').is_symlink())
        self.assertEqual((self.gadget / 'UDC').read_text(), 'controller')

    def test_onekvm_custom_network_over_budget_is_preserved(self):
        with self.assertRaisesRegex(ValueError, '端点不足'):
            helper.media_mount('onekvm', 'shared/disk.img', False, True)
        self.assertEqual((self.lun / 'file').read_text(), '')
        self.assertEqual((self.gadget / 'UDC').read_text(), 'controller')
        self.assertTrue((self.config / 'ncm.usb0').is_symlink())

    def test_iso_is_always_readonly_and_existing_link_avoids_rebind(self):
        (self.images / 'rescue.iso').write_bytes(bytes(2048))
        (self.config / 'ncm.usb0').unlink()
        self.link('mass_storage.disk0')
        with patch.object(helper.time, 'sleep') as sleep:
            helper.media_mount('pikvm', 'shared/rescue.iso', False, False)
        sleep.assert_not_called()
        self.assertEqual((self.lun / 'ro').read_text(), '1')
        self.assertEqual((self.lun / 'cdrom').read_text(), '1')

    def test_failed_mount_restores_empty_lun_flags_and_links(self):
        write = Path.write_text

        def reject_image(path, value, *args, **kwargs):
            if path == self.lun / 'file' and value.startswith('/proc/'):
                raise OSError(errno.EIO, 'mount failed')
            return write(path, value, *args, **kwargs)

        with patch.object(Path, 'write_text', reject_image), self.assertRaises(OSError):
            helper.media_mount('nanokvm', 'shared/disk.img', True, True)
        self.assertEqual((self.lun / 'file').read_text().strip(), '')
        self.assertEqual((self.lun / 'ro').read_text(), '0')
        self.assertEqual((self.lun / 'cdrom').read_text(), '0')
        self.assertEqual((self.gadget / 'UDC').read_text(), 'controller')
        self.assertTrue((self.config / 'ncm.usb0').is_symlink())
        self.assertFalse((self.config / 'mass_storage.disk0').is_symlink())

    def test_interrupted_attach_restores_controller_during_rebind(self):
        with patch.object(helper.time, 'sleep', side_effect=InterruptedError('操作已取消')):
            with self.assertRaises(InterruptedError):
                helper.media_mount('nanokvm', 'shared/disk.img', False, False)
        self.assertEqual((self.gadget / 'UDC').read_text(), 'controller')
        self.assertEqual((self.lun / 'file').read_text().strip(), '')
        self.assertTrue((self.config / 'ncm.usb0').is_symlink())
        self.assertFalse((self.config / 'mass_storage.disk0').is_symlink())

    def test_eject_rejects_changed_medium_and_host_lock_without_rebinding(self):
        (self.lun / 'file').write_text('/existing.img')
        with patch.object(helper, 'media_status', return_value={'inserted': True, 'token': 'new'}):
            with self.assertRaisesRegex(ValueError, '已改变'):
                helper.media_eject('old')
            with patch.object(Path, 'write_text', side_effect=OSError(errno.EBUSY, 'locked')):
                with self.assertRaisesRegex(ValueError, '仍锁定'):
                    helper.media_eject('new')
            self.assertEqual((self.lun / 'file').read_text(), '/existing.img')
            helper.media_eject('new')
            self.assertEqual((self.lun / 'file').read_text().strip(), '')
        self.assertEqual((self.gadget / 'UDC').read_text(), 'controller')


if __name__ == '__main__':
    unittest.main()
