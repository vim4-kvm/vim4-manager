"""Fan writes must stay within fan maps and must not persist partial success."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_helper import helper


class ThermalFanTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.thermal = self.root / 'thermal'
        self.thermal.mkdir()
        self.enterContext(patch.object(helper, 'THERMAL_SYSFS', self.thermal))
        self.config = self.root / 'config'
        self.enterContext(patch.object(helper, 'FAN_CONFIG', str(self.config)))
        fan = self.thermal / 'cooling_device19'
        fan.mkdir()
        (fan / 'type').write_text('khadas-mcu-fan')
        (fan / 'max_state').write_text('100')
        self.paths = []
        for n, kind in enumerate(('a73', 'a53', 'gpu', 'nna', 'vpu', 'hevc')):
            zone = self.thermal / f'thermal_zone{n + 8}'
            zone.mkdir()
            (zone / 'type').write_text(kind + '-thermal')
            (zone / 'trip_point_0_type').write_text('critical')
            (zone / 'trip_point_0_temp').write_text('110000')
            for i, value in enumerate(helper.thermal_fan_temperatures(60, 80, 100)):
                (zone / f'cdev{i}').symlink_to(fan, target_is_directory=True)
                (zone / f'cdev{i}_trip_point').write_text(str(i + 3))
                (zone / f'trip_point_{i + 3}_type').write_text('active')
                path = zone / f'trip_point_{i + 3}_temp'
                path.write_text(str(value))
                self.paths.append(path)

    def test_apply_readback_and_restore_all_zones(self):
        helper.fan_curve('65', '85', '100')
        self.assertIn('FAN_TRIGGER_LOW=65', self.config.read_text())
        self.assertTrue(all(int(paths[6].read_text()) == 65000 for paths in helper.thermal_fan_trips()))
        self.paths[0].write_text('20000')
        helper.fan_restore()
        self.assertEqual(self.paths[0].read_text().strip(), '50000')
        self.assertTrue(all(p.read_text() == '110000' for p in self.thermal.glob('thermal_zone*/trip_point_0_temp')))

    def test_missing_zone_prevents_any_write(self):
        (self.thermal / 'thermal_zone13/type').write_text('unrelated')
        before = [p.read_text() for p in self.paths]
        with self.assertRaisesRegex(ValueError, 'not ready'):
            helper.fan_curve('65', '85', '100')
        self.assertEqual([p.read_text() for p in self.paths], before)
        self.assertFalse(self.config.exists())

    def test_write_error_or_failed_readback_never_saves(self):
        real_write = Path.write_text
        for failure in ('error', 'ignored'):
            with self.subTest(failure=failure):
                def write(path, text, *args, **kwargs):
                    if path == self.paths[3]:
                        if failure == 'error':
                            raise OSError('injected write failure')
                        return len(text)
                    return real_write(path, text, *args, **kwargs)
                self.paths[3].write_text('52500')
                with patch.object(Path, 'write_text', write), self.assertRaisesRegex(ValueError, 'not saved'):
                    helper.fan_curve('65', '85', '100')
                self.assertFalse(self.config.exists())
