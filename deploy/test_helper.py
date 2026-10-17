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
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'board'))
import vim4media  # Preload workspace code before the production helper adds its install path.
loader = importlib.machinery.SourceFileLoader('helper', str(Path(__file__).with_name('vim4-manager-helper')))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


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
