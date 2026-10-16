import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from test_helper import helper


class MediaStatusTest(unittest.TestCase):
    def test_shared_lun_tracks_ejection_and_usb_disconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lun = root / 'gadget/functions/mass_storage.disk0/lun.0'
            lun.mkdir(parents=True)
            config = root / 'gadget/configs/c.1'
            config.mkdir(parents=True)
            (config / 'mass_storage.disk0').symlink_to(lun.parent)
            (root / 'gadget/UDC').write_text('controller')
            (root / 'udc/controller').mkdir(parents=True)
            state = root / 'udc/controller/state'
            state.write_text('configured')
            (lun / 'file').write_text('/var/lib/vim4-kvm/images/rescue.iso\n')
            (lun / 'ro').write_text('1')
            (lun / 'cdrom').write_text('1')
            with patch.multiple(helper, PIKVM_LUN_FILE=lun / 'file',
                                PIKVM_USB_STATE=root / 'pikvm', UDC_CLASS=root / 'udc'):
                status = helper.media_status()
                self.assertEqual(status['name'], 'rescue.iso')
                self.assertTrue(status['connected'] and status['inserted'] and status['readOnly'])
                self.assertFalse(status['pikvm'])
                state.write_text('not attached')
                self.assertFalse(helper.media_status()['connected'])
                self.assertTrue(helper.media_status()['inserted'])
                (root / 'pikvm').write_text('{}')
                self.assertTrue(helper.media_status()['pikvm'])
                (lun / 'file').write_text('\n')
                self.assertFalse(helper.media_status()['inserted'])
                self.assertEqual(helper.media_status()['name'], '')
                (lun / 'file').unlink()
                with self.assertRaises(OSError):
                    helper.media_status()
