import copy
import hashlib
import io
import json
import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'board'))
import vim4media  # Preload workspace code before the production helper adds its install path.
loader = importlib.machinery.SourceFileLoader('helper', str(Path(__file__).with_name('vim4-manager-helper')))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class PowerTest(unittest.TestCase):
    COMPLETE = 'PD bootstrap complete; USB-capable 5V contract established\n'

    def test_cpu_snapshot_requires_complete_model_with_physical_units(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def write(path, text):
                dest = root / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(text)
            write('proc/stat', 'cpu0 10 0 20 70 5 0 0 0 10 0\ncpu1 0 0 0 100 0 0 0 0 0 0\n')
            base = 'sys/kernel/debug/energy_model/cpu0/'
            write(base + 'units', 'milliWatts\n')
            write(base + 'cpus', '0-1\n')
            write(base + 'ps:1000000/power', '351\n')
            write('sys/devices/system/cpu/cpufreq/policy0/stats/time_in_state', '1000000 200\n')
            with patch.object(helper, 'Path', side_effect=lambda p: root / str(p).lstrip('/')):
                snapshot = helper.cpu_power_snapshot()
                self.assertEqual(snapshot[0]['cpus']['0'], {'busy': 30, 'total': 105})
                self.assertEqual(snapshot[0]['states']['1000000'], {'ticks': 200, 'milliwatts': 351})
                write(base + 'units', 'bogoWatts\n')
                with self.assertRaises(ValueError):
                    helper.cpu_power_snapshot()
                write(base + 'units', 'milliWatts\n')
                write(base + 'cpus', '0\n')
                with self.assertRaises(ValueError):
                    helper.cpu_power_snapshot()

    def test_bootstrap_requires_completion_and_uses_requested_current(self):
        log = 'Request rdo 13025896: tx 0\n'
        self.assertIsNone(helper.boot_power_contract(log))
        self.assertEqual(helper.boot_power_contract(log + self.COMPLETE),
                         {'voltageV': 5, 'currentA': 1.5})
        self.assertIsNone(helper.boot_power_contract(log.replace('tx 0', 'tx -1') + self.COMPLETE))

    def test_legacy_renegotiation_is_not_mistaken_for_initial_request(self):
        log = 'Request rdo 1304b12c: tx 0\n100 rx hdr 1261 data 1 n 1 : 2e019096\n' + self.COMPLETE
        self.assertIsNone(helper.boot_power_contract(log))
        self.assertEqual(helper.boot_power_contract(log + 'PD contract at bootstrap: 5000mV 1500mA\n'),
                         {'voltageV': 5, 'currentA': 1.5})

    def test_missing_live_probe_does_not_hide_boot_contract(self):
        with patch.object(helper.Path, 'is_file', return_value=False), patch.object(
                helper.subprocess, 'check_output', side_effect=[
                    'a' * 32, 'Request rdo 1304b12c: tx 0\n' + self.COMPLETE]) as run:
            self.assertEqual(helper.power_status(), {'vbusPresent': None,
                              'bootContract': {'voltageV': 5, 'currentA': 3}})
            self.assertIn('_SYSTEMD_INVOCATION_ID=' + 'a' * 32, run.call_args.args[0])


class WifiTest(unittest.TestCase):
    CLIENT = '11111111-1111-1111-1111-111111111111'
    HOTSPOT = '22222222-2222-2222-2222-222222222222'

    def setUp(self):
        self.enterContext(patch.object(helper, 'wifi_dbus', side_effect=self.dbus_settings))
        self.enterContext(patch.object(helper.subprocess, 'run', side_effect=self.run_nm))
        self.profiles = {}
        self.settings = {}
        self.secrets = {}
        self.calls = []
        self.active = ''
        self.radio = 'enabled:enabled\n'
        self.devices = 'eth0:ethernet\np2p-dev-wlan0:wifi-p2p\nwlan0:wifi\nwlan1:wifi\n'
        self.scan = ''
        self.fail_up = False
        self.fail_device_set = False
        self.auto_client = ''

    @staticmethod
    def escape(value):
        return str(value).replace('\\', '\\\\').replace(':', '\\:')

    def add_profile(self, identifier, ssid, hotspot=False, autoconnect=True, name=None):
        # Include a static IP setting to check that password updates preserve
        # administrator configuration, rather than replacing the profile.
        self.dbus_settings('add', settings={
            'connection': {'id': name or ('vim4-hotspot' if hotspot else ssid),
                           'uuid': identifier, 'type': '802-11-wireless', 'autoconnect': autoconnect},
            '802-11-wireless': {'ssid': ssid.encode(), 'mode': 'ap' if hotspot else 'infrastructure', 'channel': 6},
            '802-11-wireless-security': {'key-mgmt': 'wpa-psk', 'psk': 'oldsecret'},
            'ipv4': {'method': 'manual', 'address-data': [{'address': '192.168.5.3', 'prefix': 24}]},
        })

    def dbus_settings(self, action, identifier=None, settings=None):
        if action == 'read':
            config = copy.deepcopy(self.settings[identifier])
            for name, values in self.secrets[identifier].items():
                config.setdefault(name, {}).update(copy.deepcopy(values))
            return config
        self.assertIn(action, ('add', 'update'))
        config = copy.deepcopy(settings)
        connection, wifi = config['connection'], config['802-11-wireless']
        identifier = connection['uuid']
        if action == 'add':
            self.assertNotIn(identifier, self.settings)
        else:
            self.assertIn(identifier, self.settings)
        security = config.get('802-11-wireless-security', {})
        password = security.pop('psk', '')
        # Like GetSettings, the stored settings omit the secret. An Update
        # without a PSK loses it, exposing missing secret preservation.
        self.settings[identifier] = config
        self.secrets[identifier] = {'802-11-wireless-security': {'psk': password}} if password else {}
        self.profiles[connection['uuid']] = {
            'name': connection['id'], 'ssid': bytes(wifi['ssid']).decode(), 'mode': wifi['mode'],
            'autoconnect': connection.get('autoconnect', True),
            'channel': int(wifi.get('channel', '0')),
            'password': password,
        }

    def run_nm(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        self.assertEqual(kwargs['env'], helper.WIFI_ENV)
        if argv[:1] == ['iw']:
            output = 'Station AA:BB:CC:DD:EE:01 (on wlan0)\nStation aa:bb:cc:dd:ee:02 (on wlan0)\n'
        else:
            self.assertEqual(argv[0], 'nmcli')
            args = argv[1:]
            if args[:1] == ['--show-secrets']:
                args = args[1:]
            if args[:1] == ['--wait']:
                args = args[2:]
            output = ''
            if args == ['-t', '-f', 'DEVICE,TYPE', 'device']:
                output = self.devices
            elif args == ['-t', '-f', 'WIFI-HW,WIFI', 'general']:
                output = self.radio
            elif args[:2] == ['-t', '-f'] and args[3:5] == ['device', 'show']:
                output = (f'GENERAL.STATE:{"100 (connected)" if self.active else "30 (disconnected)"}\n'
                          f'GENERAL.CON-UUID:{self.active}\nGENERAL.HWADDR:AA:BB:CC:DD:BC:28\n'
                          'IP4.ADDRESS[1]:192.168.5.3/24\nIP6.ADDRESS[1]:2001:db8::1/64\n')
            elif args == ['-t', '-f', 'UUID,TYPE,NAME', 'connection', 'show']:
                output = 'not-a-wifi-id:802-3-ethernet:Wired\n' + ''.join(
                    f'{identifier}:802-11-wireless:{self.escape(p["name"])}\n' for identifier, p in self.profiles.items())
            elif args[:1] == ['-g']:
                p = self.profiles[args[-1]]
                values = {'802-11-wireless.ssid': p['ssid'], '802-11-wireless.mode': p['mode'],
                          'connection.autoconnect': 'yes' if p['autoconnect'] else 'no',
                          '802-11-wireless.channel': p['channel'], '802-11-wireless-security.psk': p['password']}
                output = ''.join(self.escape(values[field]) + '\n' for field in args[1].split(','))
            elif 'wifi' in args and 'list' in args:
                output = self.scan
            elif args[:3] == ['connection', 'up', 'uuid']:
                if self.fail_up:
                    self.fail_up = False
                    raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
                self.active = args[3]
            elif args[:2] == ['device', 'disconnect']:
                if not self.active:
                    # Real nmcli exits 6 for an inactive device.
                    raise subprocess.CalledProcessError(6, argv, stderr='This device is not active')
                self.active = ''
            elif args[:2] == ['device', 'set']:
                if self.fail_device_set:
                    raise subprocess.CalledProcessError(1, argv, stderr='NM unavailable')
                self.active = self.auto_client
            elif args[:2] == ['connection', 'modify']:
                self.profiles[args[3]]['autoconnect'] = args[5] == 'yes'
                self.settings[args[3]]['connection']['autoconnect'] = args[5] == 'yes'
            elif args[:2] == ['connection', 'delete']:
                self.profiles.pop(args[3], None)
                self.settings.pop(args[3], None)
                self.secrets.pop(args[3], None)
            else:
                self.fail(f'unexpected command {argv}')
        return subprocess.CompletedProcess(argv, 0, output, '')

    def request(self, action, body):
        with patch('sys.stdin', io.StringIO(json.dumps(body))):
            return helper.wifi_command([action])

    def test_escaped_fields_scan_dedup_and_current(self):
        self.assertEqual(helper.nm_fields(r'Home\:5G:a\\b::end'), ['Home:5G', 'a\\b', '', 'end'])
        self.add_profile(self.CLIENT, 'Home:5G')
        self.active = self.CLIENT
        self.scan = 'Home\\:5G:20:WPA2:2412 MHz:*\nHome\\:5G:90:WPA2:2437 MHz: \n:99:WPA2:2412 MHz: \nOpen:70::5180 MHz: \n'
        result = helper.wifi_command(['wifi-scan', '1'])['networks']
        self.assertEqual([n['ssid'] for n in result], ['Home:5G', 'Open'])
        self.assertTrue(result[0]['active'])
        self.assertTrue(result[0]['saved'])
        self.assertEqual((result[0]['signal'], result[0]['frequency']), (90, 2437))
        self.assertEqual(result[1]['security'], '')
        state = helper.wifi_status()
        self.assertEqual(state['current']['id'], self.CLIENT)
        self.assertEqual(state['current']['ipv4'], '192.168.5.3/24')
        self.assertEqual((state['current']['signal'], state['current']['frequency']), (20, 2412))
        self.assertEqual(state['hotspot']['ssid'], 'VIM4-KVM-BC28')
        self.assertEqual(state['hotspot']['password'], '')
        self.assertEqual(self.calls[-1][0][-1], 'no')

    def test_scan_suppressed_when_off_hotspot_or_unsupported(self):
        self.radio = 'enabled:disabled\n'
        self.assertEqual(helper.wifi_command(['wifi-scan', '1']), {'networks': []})
        self.assertEqual(helper.wifi_status()['mode'], 'off')
        self.radio = 'enabled:enabled\n'
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        self.active = self.HOTSPOT
        self.assertEqual(helper.wifi_command(['wifi-scan', '1']), {'networks': []})
        self.devices = 'p2p-dev-wlan0:wifi-p2p\n'
        self.assertFalse(helper.wifi_status()['supported'])
        self.assertEqual(helper.wifi_command(['wifi-scan', '1']), {'networks': []})
        self.assertFalse(any('list' in argv for argv, _ in self.calls))

    def test_unicode_line_separator_in_ssid_is_not_a_record_delimiter(self):
        ssid = 'Home\u2028WiFi'
        self.add_profile(self.CLIENT, ssid)
        self.scan = ssid + ':80:WPA2:2412 MHz: \n'
        network = helper.wifi_command(['wifi-scan', '0'])['networks'][0]
        self.assertEqual(network['ssid'], ssid)
        self.assertTrue(network['saved'])

    def test_station_leases_merge_only_associated_nonexpired_clients(self):
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        self.active = self.HOTSPOT
        with patch.object(helper.Path, 'read_text', return_value=(
                '9999999999 aa:bb:cc:dd:ee:01 10.42.0.2 laptop *\n'
                '1 aa:bb:cc:dd:ee:02 10.42.0.3 expired *\n'
                '9999999999 aa:bb:cc:dd:ee:03 10.42.0.4 stale *\n')):
            state = helper.wifi_status()
        self.assertEqual(state['mode'], 'hotspot')
        self.assertIsNone(state['current'])
        self.assertEqual(state['saved'], [])
        self.assertEqual(state['hotspot']['password'], 'oldsecret')
        self.assertEqual(state['hotspot']['clients'], [
            {'mac': 'aa:bb:cc:dd:ee:01', 'ip': '10.42.0.2', 'hostname': 'laptop'},
            {'mac': 'aa:bb:cc:dd:ee:02', 'ip': '', 'hostname': ''}])

    def test_validation_happens_before_any_subprocess(self):
        invalid = [
            ('wifi-connect', {'ssid': '', 'password': ''}),
            ('wifi-connect', {'ssid': '中' * 11}),
            ('wifi-connect', {'ssid': 'Home\x7f'}),
            ('wifi-connect', {'ssid': 'Home\u0085'}),
            ('wifi-connect', {'ssid': 'Home', 'password': 'short'}),
            ('wifi-connect', {'ssid': 'Home', 'password': 'g' * 64}),
            ('wifi-connect', {'ssid': 'Home', 'hidden': 'yes'}),
            ('wifi-hotspot', {'ssid': 'AP', 'password': 'a' * 64, 'channel': 1, 'autostart': False}),
            ('wifi-hotspot', {'ssid': 'AP', 'channel': 12, 'autostart': False}),
            ('wifi-hotspot', {'ssid': 'AP', 'channel': True, 'autostart': False}),
            ('wifi-hotspot', {'ssid': 'AP', 'channel': 0, 'autostart': 'no'}),
        ]
        for action, body in invalid:
            with self.subTest(action=action, body=body), self.assertRaises(ValueError):
                self.request(action, body)
        for argv in (['wifi-activate', '--help'], ['wifi-forget', self.CLIENT + '\n'],
                     ['wifi-mode', 'off'], ['wifi-autoconnect', self.CLIENT, 'maybe']):
            with self.assertRaises(ValueError):
                helper.wifi_command(argv)
        self.assertEqual(self.calls, [])

    def test_connect_password_persisted_without_argv_and_existing_settings_kept(self):
        self.add_profile(self.CLIENT, 'Home', autoconnect=False)
        original_ip = copy.deepcopy(self.settings[self.CLIENT]['ipv4'])
        password = ' pass:word\\x '
        self.request('wifi-connect', {'ssid': 'Home', 'password': password, 'hidden': True})
        self.assertEqual(self.active, self.CLIENT)
        self.assertEqual(self.profiles[self.CLIENT]['password'], password)
        self.assertEqual(self.settings[self.CLIENT]['ipv4'], original_ip)
        self.assertTrue(self.settings[self.CLIENT]['802-11-wireless']['hidden'])
        self.assertFalse(self.profiles[self.CLIENT]['autoconnect'])
        for argv, _ in self.calls:
            self.assertNotIn(password, ' '.join(argv))

    def test_failed_new_connect_deletes_only_new_profile_and_restores_hotspot(self):
        self.add_profile(self.CLIENT, 'Other', name='Home')
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        self.active = self.HOTSPOT
        self.fail_up = True
        with self.assertRaisesRegex(ValueError, '已恢复原连接'):
            self.request('wifi-connect', {'ssid': 'Home', 'password': 'newsecret'})
        self.assertEqual(set(self.profiles), {self.CLIENT, self.HOTSPOT})
        self.assertEqual(self.active, self.HOTSPOT)
        self.assertEqual(set(self.settings), {self.CLIENT, self.HOTSPOT})
        up = [(argv, options) for argv, options in self.calls if 'up' in argv]
        self.assertEqual(up[0][0][1:3], ['--wait', '45'])
        self.assertEqual(up[0][1]['timeout'], 47)
        self.assertNotIn('newsecret', repr(self.calls))

    def test_failed_password_update_restores_original_settings(self):
        self.add_profile(self.CLIENT, 'Home')
        original = self.dbus_settings('read', self.CLIENT)
        self.active = self.CLIENT
        self.fail_up = True
        with self.assertRaisesRegex(ValueError, '已恢复原连接'):
            self.request('wifi-connect', {'ssid': 'Home', 'password': 'newsecret'})
        self.assertEqual(self.dbus_settings('read', self.CLIENT), original)
        self.assertEqual(self.profiles[self.CLIENT]['password'], 'oldsecret')
        self.assertEqual(self.active, self.CLIENT)
        self.assertFalse(any('delete' in argv for argv, _ in self.calls))

    def test_hotspot_creation_and_keep_password(self):
        self.request('wifi-hotspot', {'ssid': 'AP', 'password': '', 'channel': 11, 'autostart': True})
        identifier, profile = next(iter(self.profiles.items()))
        password = profile['password']
        self.assertEqual(len(password), 12)
        self.assertFalse(any(c in '0O1lI' for c in password))
        config = self.settings[identifier]
        self.assertEqual(config['802-11-wireless'], {'ssid': b'AP', 'mode': 'ap', 'band': 'bg', 'channel': 11})
        self.assertEqual(config['802-11-wireless-security'],
                         {'key-mgmt': 'wpa-psk', 'psk-flags': 0, 'proto': ['rsn'], 'pairwise': ['ccmp']})
        self.assertEqual(config['ipv4']['method'], 'shared')
        self.assertEqual(config['ipv6']['method'], 'disabled')
        self.assertEqual(config['connection']['autoconnect-priority'], 100)
        self.assertEqual(config['connection']['interface-name'], 'wlan0')
        self.request('wifi-hotspot', {'ssid': 'Renamed', 'password': '', 'channel': 0, 'autostart': False})
        self.assertEqual(self.profiles[identifier]['password'], password)
        self.assertEqual(self.settings[identifier]['802-11-wireless']['channel'], 0)
        self.assertEqual(self.active, '')
        self.assertNotIn(password, repr(self.calls))

    def test_hotspot_password_round_trips_and_survives_channel_update(self):
        for password in ('a b  c\\d"e#f', '  lead trail  ', "x;y|z'q:"):
            with self.subTest(password=password):
                self.request('wifi-hotspot', {'ssid': 'AP', 'password': password, 'channel': 1, 'autostart': True})
                self.assertEqual(helper.wifi_status()['hotspot']['password'], password)
                self.request('wifi-hotspot', {'ssid': 'AP', 'channel': 11, 'autostart': False})
                self.assertEqual(helper.wifi_status()['hotspot']['password'], password)
                self.assertEqual(helper.wifi_status()['hotspot']['channel'], 11)
                self.assertNotIn(password, repr(self.calls))

    def test_client_omitted_password_preserves_secret_but_empty_removes_security(self):
        self.add_profile(self.CLIENT, 'Home')
        self.request('wifi-connect', {'ssid': 'Home', 'hidden': True})
        self.assertEqual(self.profiles[self.CLIENT]['password'], 'oldsecret')
        self.request('wifi-connect', {'ssid': 'Home', 'password': ''})
        self.assertNotIn('802-11-wireless-security', self.settings[self.CLIENT])
        self.assertEqual(self.secrets[self.CLIENT], {})

    def test_failed_dbus_update_restores_existing_settings_and_secret(self):
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        original = self.dbus_settings('read', self.HOTSPOT)
        failed = False

        def fail_after_update(action, identifier=None, settings=None):
            nonlocal failed
            result = self.dbus_settings(action, identifier, settings)
            if action == 'update' and not failed:
                failed = True
                raise ValueError('settings update failed')
            return result

        with patch.object(helper, 'wifi_dbus', side_effect=fail_after_update):
            with self.assertRaisesRegex(ValueError, 'settings update failed'):
                self.request('wifi-hotspot', {'ssid': 'Changed', 'password': 'newsecret',
                                              'channel': 11, 'autostart': False})
        self.assertEqual(self.dbus_settings('read', self.HOTSPOT), original)
        self.assertNotIn('newsecret', repr(self.calls))

    def test_active_hotspot_reapply_failure_restores_settings_and_password(self):
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        original = self.dbus_settings('read', self.HOTSPOT)
        self.active = self.HOTSPOT
        self.fail_up = True
        with self.assertRaisesRegex(ValueError, '已恢复原连接'):
            self.request('wifi-hotspot', {'ssid': 'Renamed', 'password': 'newsecret', 'channel': 11, 'autostart': False})
        self.assertEqual(self.dbus_settings('read', self.HOTSPOT), original)
        self.assertEqual(self.active, self.HOTSPOT)
        self.assertEqual(self.profiles[self.HOTSPOT]['password'], 'oldsecret')

    def test_client_to_hotspot_failure_restores_client(self):
        self.add_profile(self.CLIENT, 'Home')
        self.active = self.CLIENT
        self.fail_up = True
        with self.assertRaisesRegex(ValueError, '热点启动失败，已恢复原连接'):
            helper.wifi_command(['wifi-mode', 'hotspot'])
        self.assertEqual(self.active, self.CLIENT)

    def test_hotspot_to_client_fallback_force_and_success(self):
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        self.active = self.HOTSPOT
        with self.assertRaisesRegex(ValueError, '已恢复热点'):
            helper.wifi_command(['wifi-mode', 'client'])
        self.assertEqual(self.active, self.HOTSPOT)
        self.assertTrue(self.profiles[self.HOTSPOT]['autoconnect'])
        self.add_profile(self.CLIENT, 'Home')
        # Controlled deadline proves the full 30-second window without sleeps.
        with patch.object(helper.time, 'monotonic', side_effect=[100, 100, 130]), \
             patch.object(helper.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, '30 秒内'):
                helper.wifi_command(['wifi-mode', 'client'])
        self.assertEqual(self.active, self.HOTSPOT)
        helper.wifi_command(['wifi-mode', 'client', 'force'])
        self.assertEqual(self.active, '')
        self.assertFalse(self.profiles[self.HOTSPOT]['autoconnect'])
        self.active = self.HOTSPOT
        self.auto_client = self.CLIENT
        helper.wifi_command(['wifi-mode', 'client'])
        self.assertEqual(self.active, self.CLIENT)

    def test_activate_failure_restores_and_uuid_actions_reject_hotspot(self):
        self.add_profile(self.CLIENT, 'Home')
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        self.active = self.HOTSPOT
        self.fail_up = True
        with self.assertRaisesRegex(ValueError, '已恢复原连接'):
            helper.wifi_command(['wifi-activate', self.CLIENT])
        self.assertEqual(self.active, self.HOTSPOT)
        for action in ('wifi-activate', 'wifi-forget', 'wifi-autoconnect'):
            args = [action, self.HOTSPOT] + (['yes'] if action == 'wifi-autoconnect' else [])
            with self.assertRaisesRegex(ValueError, '找不到'):
                helper.wifi_command(args)
        helper.wifi_command(['wifi-activate', self.CLIENT])
        self.assertFalse(self.profiles[self.HOTSPOT]['autoconnect'])
        helper.wifi_command(['wifi-autoconnect', self.CLIENT, 'no'])
        self.assertFalse(self.profiles[self.CLIENT]['autoconnect'])
        helper.wifi_command(['wifi-disconnect'])
        self.assertEqual(self.active, '')
        self.active = self.CLIENT
        helper.wifi_command(['wifi-forget', self.CLIENT])
        self.assertEqual(self.active, '')
        self.assertNotIn(self.CLIENT, self.profiles)

    def test_force_does_not_restore_hotspot_even_when_autoconnect_fails(self):
        self.add_profile(self.HOTSPOT, 'AP', hotspot=True)
        self.active = self.HOTSPOT
        self.fail_device_set = True
        with self.assertRaises(ValueError):
            helper.wifi_command(['wifi-mode', 'client', 'force'])
        self.assertEqual(self.active, '')
        self.assertFalse(any('up' in argv for argv, _ in self.calls))

    def test_open_network_and_raw_hex_client_psk(self):
        self.request('wifi-connect', {'ssid': 'Open', 'password': ''})
        self.assertNotIn('802-11-wireless-security', self.settings[self.active])
        password = 'a' * 64
        self.request('wifi-connect', {'ssid': 'Secured', 'password': password})
        self.assertEqual(self.profiles[self.active]['password'], password)
        self.assertNotIn(password, repr(self.calls))

    def test_client_ssid_matching_reserved_hotspot_name_stays_manageable(self):
        self.request('wifi-connect', {'ssid': 'vim4-hotspot', 'password': 'secret123'})
        state = helper.wifi_status()
        self.assertEqual(state['mode'], 'client')
        self.assertEqual(state['current']['ssid'], 'vim4-hotspot')
        self.assertEqual(len(state['saved']), 1)
        helper.wifi_command(['wifi-forget', self.active])
        self.assertEqual(self.profiles, {})

    def test_reads_skip_operation_lock_writes_take_it(self):
        with patch.object(helper.os, 'open', return_value=123) as opened, \
             patch.object(helper.os, 'close'), patch.object(helper.fcntl, 'flock') as flock:
            for action in ('wifi-status', 'wifi-scan'):
                with helper.operation_lock([action]):
                    pass
            opened.assert_not_called()
            with helper.operation_lock(['wifi-connect']):
                flock.assert_called_once_with(123, helper.fcntl.LOCK_EX | helper.fcntl.LOCK_NB)


class WifiDBusTest(unittest.TestCase):
    def test_settings_snapshot_and_persistent_writes_use_dbus_types(self):
        class Dictionary(dict):
            def __init__(self, values, signature):
                super().__init__(values)
                self.signature = signature

        class UInt32(int):
            pass

        connection = Mock()
        connection.GetSettings.return_value = {
            'connection': {'uuid': WifiTest.CLIENT},
            '802-11-wireless': {'ssid': b'Home', 'channel': 6},
            '802-11-wireless-security': {'key-mgmt': 'wpa-psk', 'psk-flags': 0},
            'ipv4': {'method': 'manual', 'address-data': [{'address': '192.168.5.3', 'prefix': 24}]},
        }
        password = '  old\\secret  '
        connection.GetSecrets.return_value = {'802-11-wireless-security': {'psk': password}}
        manager = Mock()
        dbus = Mock(Dictionary=Dictionary, UInt32=UInt32, ByteArray=bytes, DBusException=RuntimeError)
        dbus.Interface.side_effect = [manager, connection, manager, connection, manager]
        with patch.dict(sys.modules, {'dbus': dbus}):
            snapshot = helper.wifi_dbus('read', WifiTest.CLIENT)
            self.assertEqual(snapshot['802-11-wireless-security']['psk'], password)
            connection.GetSecrets.assert_called_once_with('802-11-wireless-security')
            helper.wifi_dbus('update', WifiTest.CLIENT, snapshot)
            helper.wifi_dbus('add', settings=snapshot)
        manager.GetConnectionByUuid.assert_called_with(WifiTest.CLIENT)
        for settings in (connection.Update.call_args.args[0], manager.AddConnection.call_args.args[0]):
            self.assertEqual(settings, snapshot)
            self.assertEqual(settings.signature, 'sa{sv}')
            self.assertTrue(all(section.signature == 'sv' for section in settings.values()))
            self.assertIsInstance(settings['802-11-wireless']['channel'], UInt32)
            self.assertIsInstance(settings['802-11-wireless-security']['psk-flags'], UInt32)

    def test_dbus_errors_do_not_expose_secrets(self):
        dbus = Mock(DBusException=RuntimeError)
        dbus.SystemBus.side_effect = RuntimeError('PSK: secret123')
        with patch.dict(sys.modules, {'dbus': dbus}), self.assertRaises(ValueError) as raised:
            helper.wifi_dbus('read', WifiTest.CLIENT)
        self.assertNotIn('secret123', str(raised.exception))


class TailscaleTest(unittest.TestCase):
    def setUp(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(helper, 'TAILSCALE_JOB', root / 'job.json'))

    def test_rejects_invalid_arguments_before_running_commands(self):
        invalid_urls = ['', 'ftp://head.example', 'https://head.example/', 'https://head.example/path',
                        'https://user@head.example', 'https://head.example?x=1', 'https://head.example#x',
                        'https://head.example:123456', 'https://head.example;reboot',
                        'https://head.example\n', 'https://head.example$(reboot)', '--login-server=x']
        with patch.object(helper, 'tailscale_run') as run, patch.object(helper, 'tailscale_installed') as installed:
            for url in invalid_urls:
                with self.subTest(url=url), self.assertRaises(ValueError):
                    helper.main(['tailscale-login', url])
            for argv in (['tailscale-login'], ['tailscale-up', 'extra'], ['tailscale-set'],
                         ['tailscale-ping'], ['tailscale-ping', '100.64.0.2', 'extra'],
                         ['tailscale-login', 'https://head.example', '--accept-routes']):
                with self.subTest(argv=argv), self.assertRaises(ValueError):
                    helper.main(argv)
        installed.assert_not_called()
        run.assert_not_called()

    def test_uninstalled_actions_are_rejected_but_status_and_cleanup_work(self):
        with patch.object(helper, 'tailscale_installed', return_value=False), \
             patch.object(helper, 'tailscale_run') as run:
            for action in ('up', 'down', 'login', 'logout', 'ping'):
                args = ['tailscale-' + action] + (['https://head.example'] if action == 'login' else
                                                ['100.64.0.2'] if action == 'ping' else [])
                with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'not installed'):
                    helper.main(args)
            run.assert_not_called()
            state = helper.tailscale_status()
            self.assertFalse(state['installed'])
            self.assertFalse(state['running'])
            self.assertEqual(state['ips'], [])
            self.assertEqual(state['devices'], [])
            self.assertEqual(state['controlURL'], helper.TAILSCALE_CONTROL)
            with patch.object(helper, 'tailscale_start_package') as launch, \
                 patch('sys.stdout', new_callable=io.StringIO):
                helper.main(['tailscale-install'])
                helper.main(['tailscale-uninstall'])
            self.assertEqual([call.args for call in launch.call_args_list], [('install',), ('uninstall',)])

    def test_status_parses_auth_url_peers_and_headscale_control(self):
        status = {'BackendState': 'NeedsLogin', 'AuthURL': 'https://head.example/register/node',
                  'Version': '1.90.1', 'Self': {'HostName': 'vim4', 'DNSName': 'vim4.example.',
                  'TailscaleIPs': ['100.64.0.1', 'fd00::1']}, 'CurrentTailnet': {'Name': 'example'},
                  'Peer': {'a': {'Online': True}, 'b': {'Online': False}, 'c': {'Online': True}}}
        def run(*args, **kwargs):
            data = status if args[1] == 'status' else {'ControlURL': 'http://head.example:8080'}
            # A valid NeedsLogin JSON response can have a failing exit status.
            return subprocess.CompletedProcess(args, 1 if args[1] == 'status' else 0, json.dumps(data), '')
        with patch.object(helper, 'tailscale_installed', return_value=True), \
             patch.object(helper, 'tailscale_run', side_effect=run):
            state = helper.tailscale_status()
        self.assertEqual(state, {'installed': True, 'running': True, 'backendState': 'NeedsLogin',
                                'authURL': status['AuthURL'], 'hostName': 'vim4', 'dnsName': 'vim4.example',
                                'ips': ['100.64.0.1', 'fd00::1'], 'tailnet': 'example',
                                'controlURL': 'http://head.example:8080', 'version': '1.90.1',
                                'peers': 3, 'peersOnline': 2,
                                'devices': [{'id': '', 'hostName': '', 'dnsName': '', 'os': '', 'ips': [],
                                             'online': online, 'lastSeen': '', 'curAddr': '', 'relay': '',
                                             'exitNode': False, 'active': False} for online in (True, True, False)]})

    def test_status_devices_fields_sorting_and_zero_last_seen(self):
        full_peer = {'ID': 'node-id', 'HostName': 'zulu', 'DNSName': 'zulu.example.', 'OS': 'linux',
                     'TailscaleIPs': ['100.64.0.2', 'fd7a:115c:a1e0::2'], 'Online': True,
                     'LastSeen': '2026-10-16T12:34:56.123Z', 'CurAddr': '[2001:db8::2]:41641',
                     'Relay': 'lax', 'ExitNode': True, 'Active': True}
        peers = {'public-key': full_peer,
                 'b': {'ID': 'offline-z', 'HostName': 'zulu', 'Online': False},
                 'c': {'ID': 'online-a', 'HostName': 'alpha', 'Online': True,
                       'LastSeen': '0001-01-01T00:00:00Z'},
                 'd': {'ID': 'offline-a', 'HostName': 'alpha', 'Online': False,
                       'LastSeen': '0001-01-01T00:00:00.000000000Z'}}
        def run(*args, **kwargs):
            data = {'Peer': peers, 'Self': {'ID': 'self'}} if args[1] == 'status' else {}
            return subprocess.CompletedProcess(args, 0, json.dumps(data), '')
        with patch.object(helper, 'tailscale_installed', return_value=True), \
             patch.object(helper, 'tailscale_run', side_effect=run):
            state = helper.tailscale_status()
        self.assertEqual((state['peers'], state['peersOnline']), (4, 2))
        devices = state['devices']
        self.assertEqual([d['id'] for d in devices], ['online-a', 'node-id', 'offline-a', 'offline-z'])
        self.assertEqual(devices[1], {'id': 'node-id', 'hostName': 'zulu', 'dnsName': 'zulu.example',
                                     'os': 'linux', 'ips': full_peer['TailscaleIPs'], 'online': True,
                                     'lastSeen': full_peer['LastSeen'], 'curAddr': full_peer['CurAddr'],
                                     'relay': 'lax', 'exitNode': True, 'active': True})
        self.assertEqual([d['lastSeen'] for d in (devices[0], *devices[2:])], ['', '', ''])

    def test_ping_parses_paths_losses_and_nonzero_exit(self):
        direct = 'pong from laptop (100.64.0.2) via 192.0.2.2:41641 in 1.25ms'
        derp = 'pong from laptop (100.64.0.2) via DERP(lax) in 45ms'
        relay = 'pong from laptop (100.64.0.2) via peer-relay(100.64.0.3:40000) in 8.5ms'
        timeout = 'ping "100.64.0.2" timed out'
        cases = [(direct, 'direct', '192.0.2.2:41641', [1.25], 0),
                 (derp, 'derp', 'lax', [45.0], 0),
                 (relay, 'peer-relay', '100.64.0.3:40000', [8.5], 0),
                 ('\n'.join([timeout] * 4), '', '', [], 4),
                 ('\n'.join([timeout, derp, relay, direct, timeout]),
                  'direct', '192.0.2.2:41641', [45.0, 8.5, 1.25], 2)]
        for output, path, via, latencies, lost in cases:
            with self.subTest(path=path, lost=lost), \
                 patch.object(helper, 'tailscale_installed', return_value=True), \
                 patch.object(helper, 'tailscale_run', side_effect=[
                     subprocess.CompletedProcess([], 0, json.dumps({'Peer': {
                         'key': {'TailscaleIPs': ['100.64.0.2']}}}), ''),
                     subprocess.CompletedProcess([], 1, output, 'diagnostic')]) as run, \
                 patch('sys.stdout', new_callable=io.StringIO) as stdout:
                helper.main(['tailscale-ping', '100.64.0.2'])
                self.assertEqual(json.loads(stdout.getvalue()), {
                    'reachable': bool(latencies), 'path': path, 'via': via,
                    'latencyMs': latencies, 'lost': lost, 'sent': len(latencies) + lost})
                self.assertEqual(run.call_args_list[0].args, ('tailscale', 'status', '--json'))
                run.assert_called_with('tailscale', 'ping', '--until-direct=false', '--c', '4',
                                       '--timeout', '3s', '100.64.0.2', timeout=20, check=False)

    def test_ping_rejects_invalid_or_non_tailnet_addresses_before_commands(self):
        for ip in ('', 'example.com', '192.168.1.1', '100.63.255.255', '100.128.0.0',
                   'fd7a:115c:a1df::1', 'fd7a:115c:a1e1::1', '::ffff:100.64.0.2',
                   'fd7a:115c:a1e0::2%eth0', '100.064.0.2', '100.64.0.2/32',
                   ' 100.64.0.2', '100.64.0.2\n', '100.64.0.2;reboot', '$(reboot)', '--help'):
            with self.subTest(ip=ip), patch.object(helper, 'tailscale_installed', return_value=True), \
                 patch.object(helper, 'tailscale_run') as run, self.assertRaises(ValueError):
                helper.tailscale_command(['tailscale-ping', ip])
            run.assert_not_called()

    def test_ping_requires_peer_membership_and_normalizes_ipv6(self):
        peer_ip = 'fd7a:115c:a1e0::2'
        status = {'Self': {'TailscaleIPs': ['100.64.0.1']},
                  'Peer': {'key': {'TailscaleIPs': ['100.64.0.2', peer_ip]}}}
        with patch.object(helper, 'tailscale_installed', return_value=True), \
             patch.object(helper, 'tailscale_run', return_value=subprocess.CompletedProcess(
                 [], 0, json.dumps(status), '')) as run:
            for ip in ('100.64.0.1', '100.64.0.3', 'fd7a:115c:a1e0::3'):
                with self.subTest(ip=ip), self.assertRaisesRegex(ValueError, 'not a current'):
                    helper.tailscale_command(['tailscale-ping', ip])
            self.assertTrue(all(call.args == ('tailscale', 'status', '--json') for call in run.call_args_list))
            run.reset_mock()
            run.side_effect = [subprocess.CompletedProcess([], 0, json.dumps(status), ''),
                               subprocess.CompletedProcess([], 0, '', '')]
            self.assertEqual(helper.tailscale_command(['tailscale-ping', 'fd7a:115c:a1e0:0:0:0:0:2'])['sent'], 0)
            self.assertEqual(run.call_args.args[-1], peer_ip)

    def test_stopped_daemon_and_default_control(self):
        with patch.object(helper, 'tailscale_installed', return_value=True), \
             patch.object(helper, 'tailscale_run', return_value=subprocess.CompletedProcess([], 1, '', 'stopped')):
            state = helper.tailscale_status()
            self.assertTrue(state['installed'])
            self.assertFalse(state['running'])
            self.assertEqual(state['devices'], [])
        with patch.object(helper, 'tailscale_installed', return_value=True), \
             patch.object(helper, 'tailscale_run', return_value=subprocess.CompletedProcess([], 0, '{}', '')):
            state = helper.tailscale_status()
            self.assertTrue(state['running'])
            self.assertEqual(state['controlURL'], helper.TAILSCALE_CONTROL)
            self.assertEqual(state['peers'], 0)
            self.assertEqual(state['devices'], [])

    def test_login_is_supervised_and_uses_daemon_auth_url(self):
        for status, url in (({'AuthURL': 'https://head.example/register/node'}, 'https://head.example/register/node'),
                            ({'BackendState': 'Running'}, '')):
            def run(*args, **kwargs):
                data = status if args[1] == 'status' else {'ControlURL': 'http://head.example:8080'}
                return subprocess.CompletedProcess(args, 0, json.dumps(data), '')
            with self.subTest(status=status), patch.object(helper, 'tailscale_installed', return_value=True), \
                 patch.object(helper, 'tailscale_run', side_effect=run) as commands, \
                 patch.object(helper.subprocess, 'Popen') as popen, patch('sys.stdout', new_callable=io.StringIO) as output:
                helper.main(['tailscale-login', 'http://head.example:8080'])
                self.assertEqual(json.loads(output.getvalue()), {'authURL': url})
                popen.assert_not_called()
                launches = [call.args for call in commands.call_args_list if call.args[0] == 'systemd-run']
                self.assertEqual(len(launches), 1)
                self.assertIn('--unit=' + helper.TAILSCALE_LOGIN_UNIT, launches[0])
                self.assertIn('--property=RuntimeMaxSec=10min', launches[0])

    def test_login_waits_for_control_server_change(self):
        statuses = iter([{'BackendState': 'Running'}, {'AuthURL': 'https://head.example/register/node'}])
        controls = iter([helper.TAILSCALE_CONTROL, 'https://head.example'])
        def run(*args, **kwargs):
            if args[0] in ('systemctl', 'systemd-run'):
                return subprocess.CompletedProcess(args, 0, '', '')
            data = next(statuses) if args[1] == 'status' else {'ControlURL': next(controls)}
            return subprocess.CompletedProcess(args, 0, json.dumps(data), '')
        with patch.object(helper, 'tailscale_run', side_effect=run), \
             patch.object(helper, 'tailscale_status', return_value={'backendState': 'NeedsLogin', 'controlURL': helper.TAILSCALE_CONTROL}), \
             patch.object(helper.time, 'sleep'):
            result = helper.tailscale_login('https://head.example')
        self.assertEqual(result, {'authURL': 'https://head.example/register/node'})

    def test_login_poll_is_bounded(self):
        now = [0.0]
        with patch.object(helper, 'tailscale_run', return_value=subprocess.CompletedProcess([], 1, '', '')), \
             patch.object(helper.subprocess, 'Popen'), \
             patch.object(helper.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(helper.time, 'sleep', side_effect=lambda duration: now.__setitem__(0, now[0] + duration)):
            with self.assertRaisesRegex(ValueError, '30 seconds'):
                helper.tailscale_login('https://head.example')
        self.assertEqual(now[0], 30)

    def test_tailscale_lock_does_not_block_switch_or_status_and_is_released(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        real_open = helper.os.open
        paths = set()
        def lock_open(path, flags, mode):
            paths.add(path)
            return real_open(root / Path(path).name, flags, mode)
        with patch.object(helper.os, 'open', side_effect=lock_open):
            with helper.operation_lock(['tailscale-install']):
                with helper.operation_lock(['select', 'nanokvm']), helper.operation_lock(['tailscale-status']):
                    with helper.operation_lock(['tailscale-ping', '100.64.0.2']):
                        pass
                with self.assertRaises(BlockingIOError):
                    with helper.operation_lock(['tailscale-down']):
                        self.fail('concurrent Tailscale writer acquired lock')
            with helper.operation_lock(['tailscale-up']):
                pass
        self.assertEqual(paths, {'/run/lock/vim4-manager.lock', '/run/lock/vim4-manager-tailscale.lock'})

    def test_install_uses_signed_source_and_refreshes_only_tailscale(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        keyring, source = root / 'key.gpg', root / 'tailscale.list'
        with patch.object(helper, 'TAILSCALE_KEYRING', keyring), patch.object(helper, 'TAILSCALE_SOURCES', source), \
             patch.object(helper, 'tailscale_installed', return_value=False), \
             patch.object(Path, 'read_text', return_value='VERSION_CODENAME="jammy"\n'), \
             patch.object(helper.urllib.request, 'urlopen', return_value=io.BytesIO(b'signed-key')) as fetch, \
             patch.object(helper, 'tailscale_run') as run:
            helper.tailscale_install()
        fetch.assert_called_once_with(helper.TAILSCALE_REPOSITORY + '/jammy.noarmor.gpg', timeout=30)
        self.assertEqual(keyring.read_bytes(), b'signed-key')
        self.assertIn(f'[signed-by={keyring}]', source.read_text())
        self.assertIn(f'Dir::Etc::sourcelist={source}', run.call_args_list[0].args)
        self.assertIn('Dir::Etc::sourceparts=-', run.call_args_list[0].args)
        self.assertEqual(run.call_args.args, ('systemctl', 'enable', '--now', 'tailscaled.service'))

    def test_up_enables_daemon_and_down_preserves_it(self):
        with patch.object(helper, 'tailscale_installed', return_value=True), \
             patch.object(helper, 'tailscale_local_api', return_value={}) as local_api, \
             patch.object(helper, 'tailscale_run') as run:
            helper.tailscale_command(['tailscale-up'])
            self.assertEqual(run.call_args.args, ('systemctl', 'enable', '--now', 'tailscaled.service'))
            local_api.assert_called_once_with('PATCH', 'prefs', {'WantRunning': True, 'WantRunningSet': True})
            run.reset_mock()
            helper.tailscale_command(['tailscale-down'])
            self.assertEqual(run.call_args.args, ('tailscale', 'down'))

    def test_switch_requires_the_current_server_confirmation(self):
        current = {'backendState': 'Running', 'controlURL': 'https://old.example'}
        def run(*args, **kwargs):
            data = {'AuthURL': 'https://new.example/register/node'} if args[1] == 'status' else {'ControlURL': 'https://new.example'}
            return subprocess.CompletedProcess(args, 0, json.dumps(data), '')
        with patch.object(helper, 'tailscale_status', return_value=current), \
             patch.object(helper, 'tailscale_run', side_effect=run) as commands:
            for previous in ('', 'https://stale.example'):
                with self.assertRaisesRegex(ValueError, '确认'):
                    helper.tailscale_login('https://new.example', previous)
            self.assertFalse(any(call.args[0] == 'systemd-run' for call in commands.call_args_list))
            result = helper.tailscale_login('https://new.example', 'https://old.example')
            self.assertEqual(result['authURL'], 'https://new.example/register/node')

    def test_package_worker_publishes_outcome_and_has_separate_lifecycle(self):
        with patch.object(helper, 'tailscale_run') as run:
            helper.tailscale_start_package('install')
        self.assertTrue(json.loads(helper.TAILSCALE_JOB.read_text())['running'])
        self.assertEqual(run.call_args.args[0], 'systemd-run')
        self.assertIn('--property=RuntimeMaxSec=15min', run.call_args.args)
        self.assertEqual(run.call_args.args[-2:], ('tailscale-package', 'install'))
        with patch.object(helper, 'tailscale_install', side_effect=ValueError('apt failed')):
            with self.assertRaisesRegex(ValueError, 'apt failed'):
                helper.tailscale_package('install')
        job = json.loads(helper.TAILSCALE_JOB.read_text())
        self.assertFalse(job['running'])
        self.assertEqual(job['error'], 'apt failed')

    def test_update_and_tailscale_packages_share_a_lock_without_blocking_switches(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        real_open = helper.os.open
        def lock_open(path, flags, mode):
            return real_open(root / Path(path).name, flags, mode)
        with patch.object(helper.os, 'open', side_effect=lock_open):
            with helper.operation_lock(['tailscale-package', 'install']):
                with self.assertRaises(BlockingIOError):
                    with helper.operation_lock(['update', 'vim4-manager']):
                        self.fail('concurrent package transaction acquired lock')
                with helper.operation_lock(['select', 'nanokvm']):
                    pass

    def test_auth_links_reject_unsafe_schemes_and_userinfo(self):
        for url in ('javascript:alert(1)', 'data:text/html,hello', '//head.example/a', 'https://user@head.example/a', 'https://head.example/\n'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                helper.tailscale_auth_url(url)


class HelperTest(unittest.TestCase):
    def test_existing_app_media_blocks_entering_pikvm_before_service_changes(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        lun = root / 'lun'
        lun.write_text('/var/lib/vim4-kvm/usb/disk.img\n')
        with patch.object(helper, 'PIKVM_USB_STATE', root / 'absent-state'), patch.object(helper, 'PIKVM_LUN_FILE', lun):
            for args in (['select', 'pikvm'], ['restart', 'vim4-pikvm.service']):
                with self.subTest(args=args), self.assertRaisesRegex(ValueError, 'disk.img.*安全弹出'):
                    helper.main(args)
            self.assertEqual(self.calls, [])
            lun.write_text('\n')
            with patch.object(helper, 'installed', return_value=True), patch.object(helper.os, 'sync'):
                helper.main(['select', 'pikvm'])
            self.assertIn(('restart', 'vim4-pikvm.service'), self.calls)

    def test_mounted_pikvm_media_blocks_switch_before_any_service_change(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        state, lun = root / 'state', root / 'lun'
        state.write_text('{}')
        lun.write_text('/var/lib/kvmd/msd/disk.img\n')
        with patch.object(helper, 'PIKVM_USB_STATE', state), patch.object(helper, 'PIKVM_LUN_FILE', lun):
            for args in (['select', 'nanokvm'], ['restart', 'vim4-pikvm.service'],
                         ['restart', 'vim4-kvm-hdmi.service']):
                with self.subTest(args=args), self.assertRaisesRegex(ValueError, 'disk.img.*安全弹出'):
                    helper.main(args)
        self.assertEqual(self.calls, [])

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
        self.enterContext(patch.object(helper.platform, 'release', return_value='5.15-test'))
        self.active = set()
        patcher = patch.object(helper, 'systemctl', side_effect=lambda *args: self.calls.append(args))
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_is_active(self, args, **kwargs):
        return type('Result', (), {'returncode': 0 if args[-1] in self.active else 3})()

    def test_select_disables_other_before_enabling(self):
        with patch.object(helper, 'installed', return_value=True), patch.object(helper.os, 'sync') as sync:
            helper.main(['select', 'jetkvm'])
        self.assertEqual(self.calls, [('disable', 'nanokvm.service', 'one-kvm.service', 'vim4-pikvm.service'), ('enable', 'vim4-kvm.service'),
                                      ('stop', 'nanokvm.service', 'one-kvm.service', 'vim4-pikvm.service'),
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
        self.assertEqual(self.calls, [('stop', 'vim4-kvm.service', 'one-kvm.service', 'vim4-pikvm.service'), ('restart', 'nanokvm.service')])

    def test_all_apps_release_resources_before_replacement(self):
        for app, unit in helper.APPS.items():
            with self.subTest(app=app), patch.object(helper, 'installed', return_value=True), patch.object(helper.os, 'sync'):
                self.calls.clear()
                helper.main(['select', app])
                stopped = next(call[1:] for call in self.calls if call[0] == 'stop')
                self.assertEqual(set(stopped), set(helper.APPS.values()) - {unit})
                self.assertLess(next(i for i, call in enumerate(self.calls) if call[0] == 'stop'),
                                next(i for i, call in enumerate(self.calls) if call[0] == 'restart'))

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

    def hdr_config(self):
        path = Path(self.enterContext(tempfile.TemporaryDirectory())) / 'vim4-kvm-hdr'
        self.enterContext(patch.object(helper, 'HDR_CONFIG', str(path)))
        self.enterContext(patch.object(helper.os, 'sync'))
        self.applied = []
        self.enterContext(patch.object(helper.subprocess, 'run',
                                       side_effect=lambda args, **kwargs: self.applied.append(args)))
        return path

    def test_hdr_curve_applies_live_and_saves_without_restarting_capture(self):
        path = self.hdr_config()
        helper.main(['hdr-curve', '203', '1000'])
        self.assertEqual(self.applied, [[helper.HDR_CURVE, 'apply', '203', '1000']])
        self.assertEqual(path.read_text(), 'HDR_SDR_WHITE=203\nHDR_SDR_PEAK=1000\n')
        self.assertEqual(self.calls, [])

    def test_hdr_preview_does_not_save(self):
        path = self.hdr_config()
        helper.main(['hdr-preview', '180', '2000'])
        self.assertEqual(self.applied, [[helper.HDR_CURVE, 'apply', '180', '2000']])
        self.assertFalse(path.exists())

    def test_failed_apply_keeps_saved_curve(self):
        path = self.hdr_config()
        path.write_text('HDR_SDR_WHITE=250\n')
        with patch.object(helper.subprocess, 'run', side_effect=subprocess.CalledProcessError(3, 'apply')):
            with self.assertRaises(subprocess.CalledProcessError):
                helper.main(['hdr-curve', '203', '1000'])
        self.assertEqual(path.read_text(), 'HDR_SDR_WHITE=250\n')

    def test_hdr_curve_rejects_values_the_curve_tool_refuses(self):
        path = self.hdr_config()
        for action in ('hdr-curve', 'hdr-preview'):
            for white, peak in (('159', '1000'), ('1001', '2000'), ('203', '203'), ('203', '10001'),
                                ('2e2', '1000'), ('²⁰³', '1000'), ('203', '-1'), ('203', '1000\nHDMI_WIDTH=1')):
                with self.subTest(action=action, white=white, peak=peak), self.assertRaises(ValueError):
                    helper.main([action, white, peak])
        self.assertFalse(path.exists())
        self.assertEqual(self.applied, [])

    def fan_sysfs(self, low=60, mid=80, high=100):
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        sysfs = root / 'fan'
        sysfs.mkdir()
        values = {'trigger_temp_low': low, 'trigger_temp_mid': mid, 'trigger_temp_high': high, 'mode': 0}
        self.fan_writes = []
        real_write = Path.write_text

        # Model the driver: each trigger write must keep low < mid < high.
        def write(path, text, *args, **kwargs):
            if path.parent != sysfs:
                return real_write(path, text, *args, **kwargs)
            trial = {**values, path.name: int(text)}
            if not trial['trigger_temp_low'] < trial['trigger_temp_mid'] < trial['trigger_temp_high']:
                raise OSError(22, 'Invalid argument')
            values.update(trial)
            self.fan_writes.append((path.name, int(text)))
            return real_write(path, f'{path.name}:{text}')

        for name, value in values.items():
            real_write(sysfs / name, f'{name}:{value}\n')
        self.enterContext(patch.object(Path, 'write_text', write))
        self.enterContext(patch.object(helper, 'FAN_SYSFS', sysfs))
        self.enterContext(patch.object(helper, 'FAN_CONFIG', str(root / 'vim4-kvm-fan')))
        self.enterContext(patch.object(helper.os, 'sync'))
        return values, root / 'vim4-kvm-fan'

    def test_fan_curve_reaches_any_valid_curve_through_valid_steps(self):
        for start, target in (((60, 80, 100), (35, 40, 45)), ((35, 40, 45), (80, 95, 100)),
                              ((60, 80, 100), (75, 85, 90)), ((70, 75, 80), (40, 90, 100))):
            with self.subTest(start=start, target=target):
                values, config = self.fan_sysfs(*start)
                helper.main(['fan-curve', *map(str, target)])
                self.assertEqual((values['trigger_temp_low'], values['trigger_temp_mid'],
                                  values['trigger_temp_high'], values['mode']), (*target, 1))
                self.assertEqual(config.read_text(),
                                 'FAN_TRIGGER_LOW={}\nFAN_TRIGGER_MID={}\nFAN_TRIGGER_HIGH={}\n'.format(*target))

    def test_fan_curve_rejects_invalid_curves_without_writing(self):
        for args in (('34', '80', '100'), ('60', '64', '100'), ('60', '80', '84'), ('60', '80', '101'),
                     ('60', '80', '1e2'), ('60', '80', '100\nX=1')):
            with self.subTest(args=args):
                values, config = self.fan_sysfs()
                with self.assertRaises(ValueError):
                    helper.main(['fan-curve', *args])
                self.assertEqual(self.fan_writes, [])
                self.assertFalse(config.exists())

    def test_fan_restore_applies_saved_curve_only(self):
        values, config = self.fan_sysfs()
        helper.main(['fan-restore'])
        self.assertEqual(self.fan_writes, [])
        config.write_text('FAN_TRIGGER_LOW=50\nFAN_TRIGGER_MID=70\nFAN_TRIGGER_HIGH=90\n')
        helper.main(['fan-restore'])
        self.assertEqual([values[k] for k in ('trigger_temp_low', 'trigger_temp_mid', 'trigger_temp_high')], [50, 70, 90])
        config.write_text('FAN_TRIGGER_LOW=50\n')
        with self.assertRaises(ValueError):
            helper.main(['fan-restore'])

    def test_unmanaged_requests_rejected(self):
        for argv in (['restart', 'vim4-kvm-gadget.service'], ['restart', 'ssh.service'], ['select', 'other'],
                     ['select'], ['enable', 'nanokvm.service'], ['hdr-curve', '203'], ['fan-curve', '60', '80'], []):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                helper.main(argv)
        self.assertEqual(self.calls, [])


    def update(self, data=b'package', checksum=None, installed='2.5.1+vim4.20261015.1',
               plan='Inst vim4-pikvm [2.5.1+vim4.20261015.1] (2.5.1+vim4.20261016.1)\n', active=False, mounted=False,
               verification=''):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        downloads = root / 'downloads'
        downloads.mkdir()
        lun = root / 'lun'
        lun.write_text('/var/lib/kvmd/msd/disk.img' if mounted else '')
        (downloads / 'vim4-pikvm.deb').write_bytes(data)
        version, commands = '2.5.1+vim4.20261016.1', []
        fields = {'Package': 'vim4-pikvm', 'Architecture': 'arm64', 'Version': version}

        def update_run(*args):
            commands.append(args[0])
            if args[:2] == ('dpkg', '--verify'):
                return verification
            return fields[args[3]] if args[0] == 'dpkg-deb' else plan if args[0] == 'apt-get' else ''

        def run(args, **kwargs):
            commands.append(' '.join(args[:2]))
            code = {'dpkg-query': 0, 'dpkg': 0 if installed < version else 1,
                    'systemctl': 0 if active else 3, 'systemd-run': 0}[args[0]]
            return type('Result', (), {'returncode': code, 'stdout': installed})()
        with patch.object(helper, 'UPDATE_DOWNLOADS', downloads), patch.object(helper, 'UPDATE_STAGING', root / 'staging'), \
                patch.object(helper, 'PIKVM_LUN_FILE', lun), patch.object(helper, 'PIKVM_USB_STATE', root / 'absent'), \
                patch.object(helper, 'update_run', side_effect=update_run), \
                patch.object(helper.subprocess, 'run', side_effect=run), patch.object(helper.os, 'sync'):
            helper.main(['update', 'vim4-pikvm', checksum or hashlib.sha256(data).hexdigest(), version])
        return commands

    def test_update_installs_verified_newer_package_and_restarts_running_service(self):
        commands = self.update(active=True)
        self.assertIn('dpkg', commands)
        self.assertLess(commands.index('apt-get'), commands.index('dpkg'))
        self.assertEqual(commands[-1], 'systemd-run --on-active=3')

    def test_update_does_not_start_stopped_service(self):
        self.assertNotIn('systemd-run --on-active=3', self.update())

    def test_update_rejects_unsafe_packages_before_dpkg(self):
        for name, kwargs, message in (
                ('checksum', dict(checksum='0' * 64), 'SHA256'),
                ('downgrade', dict(installed='2.5.1+vim4.20261017.1'), 'not newer'),
                ('missing', dict(installed=''), 'not installed'),
                ('platform', dict(plan='Inst vim4-amlvenc [1] (2)\nInst vim4-pikvm [1] (2)\n'), 'platform'),
                ('removal', dict(plan='Remv vim4-nanokvm [1]\n'), 'platform')):
            with self.subTest(name), self.assertRaisesRegex(ValueError, message):
                self.update(**kwargs)

    def test_update_refuses_mounted_media(self):
        with self.assertRaisesRegex(ValueError, 'disk.img.*安全弹出'):
            self.update(mounted=True)

    def test_update_preserves_pikvm_settings_but_rejects_missing_or_damaged_programs(self):
        self.update(verification='??5?????? c /etc/kvmd/nginx/vim4.conf')
        for verification in ('missing   c /etc/kvmd/nginx/vim4.conf',
                             '??5??????   /usr/libexec/vim4-pikvm-media',
                             '??5?????? c /etc/sudoers.d/vim4-pikvm-media'):
            with self.subTest(verification=verification), self.assertRaisesRegex(ValueError, 'verification failed'):
                self.update(verification=verification)

    def test_update_rejects_other_packages_and_linked_downloads(self):
        for argv in (['update', 'vim4-nanokvm', '0' * 64, '2.5.1+vim4.20261016.1'],
                     ['update', 'vim4-pikvm', 'bad', '2.5.1+vim4.20261016.1'],
                     ['update', 'vim4-pikvm', '0' * 64, '2.5.1']):
            with self.subTest(argv=argv), self.assertRaises(ValueError):
                helper.main(argv)
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (root / 'secret').write_bytes(b'x')
        (root / 'vim4-pikvm.deb').symlink_to(root / 'secret')
        with patch.object(helper, 'UPDATE_DOWNLOADS', root), self.assertRaises(OSError):
            helper.open_download('vim4-pikvm')


if __name__ == '__main__':
    unittest.main()
