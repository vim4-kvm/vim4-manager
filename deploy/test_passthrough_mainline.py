import importlib.machinery
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch


loader = importlib.machinery.SourceFileLoader('mainline_passthrough',
                                             str(Path(__file__).with_name('vim4-passthrough')))
spec = importlib.util.spec_from_loader(loader.name, loader)
passthrough = importlib.util.module_from_spec(spec)
loader.exec_module(passthrough)


class MainlinePassthroughTests(unittest.TestCase):
    def call(self, state, method='status', flags=0):
        connection = Mock()
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        connection.recvmsg.return_value = (
            json.dumps({'version': 1, 'state': state}).encode(), [], flags, None)
        with patch.object(passthrough.socket, 'socket', return_value=connection):
            controller = passthrough.MainlinePassthrough('/test/control.sock')
            result = controller.status() if method == 'status' else controller.set(True, False, True)
        return result, json.loads(connection.sendall.call_args.args[0])

    def state(self, **overrides):
        return dict({'supported': True, 'enabled': True, 'audio': False,
                     'hdr': True, 'state': 'running', 'output': {'hdrToSdr': True}}, **overrides)

    def test_actual_mapping_is_independent_of_hdr_preference(self):
        result, request = self.call(self.state(), 'set')
        self.assertEqual(request, {'version': 1, 'op': 'set',
                                  'preferences': {'enabled': True, 'audio': False, 'hdr': True}})
        self.assertTrue(result['hdr'])
        self.assertTrue(result['output']['hdrToSdr'])

    def test_get_is_status_only_and_does_not_start_vendor_units(self):
        with patch.object(passthrough.subprocess, 'run') as run:
            result, request = self.call(self.state(state='starting', output=None))
        self.assertEqual(request, {'version': 1, 'op': 'status'})
        self.assertEqual(result['state'], 'starting')
        run.assert_not_called()

    @unittest.skipUnless(hasattr(socket, 'SOCK_SEQPACKET'), 'Unix seqpacket unavailable')
    def test_real_control_transport_preserves_requested_and_actual_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'control.sock')
            server = None
            try:
                server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
                server.bind(path)
                server.listen(1)
            except OSError:
                if server is not None:
                    server.close()
                self.skipTest('Unix seqpacket unsupported on this host')
            request = []
            failures = []
            def reply():
                try:
                    server.settimeout(3)
                    with server.accept()[0] as client:
                        request.append(json.loads(client.recv(4096)))
                        client.sendall(json.dumps({'version': 1, 'state': self.state()}).encode())
                except Exception as error:
                    failures.append(error)
            thread = threading.Thread(target=reply)
            thread.start()
            try:
                state = passthrough.MainlinePassthrough(path).set(True, False, True)
            finally:
                thread.join(4)
                server.close()
            self.assertFalse(thread.is_alive())
            self.assertFalse(failures)
            self.assertEqual(request[0]['preferences']['hdr'], True)
            self.assertTrue(state['output']['hdrToSdr'])

    def test_missing_broker_is_unsupported_and_set_fails(self):
        with patch.object(passthrough.socket, 'socket', side_effect=FileNotFoundError):
            self.assertFalse(passthrough.MainlinePassthrough().status()['supported'])
            with self.assertRaises(ValueError):
                passthrough.MainlinePassthrough().set(True, True, True)

    def test_incomplete_or_contradictory_readback_is_rejected(self):
        for state in (self.state(output={}), self.state(supported=False),
                      self.state(audio=1), self.state(output={'hdrToSdr': 'true'})):
            with self.subTest(state=state), self.assertRaises(ValueError):
                self.call(state)
        with self.assertRaises(ValueError):
            self.call(self.state(), flags=socket.MSG_TRUNC)

    def test_mainline_never_enters_vendor_prepare_watch_or_audio(self):
        with patch.object(passthrough.platform, 'release', return_value='7.3.0-vim4kvm-uhd4+'):
            for command in ('prepare', 'watch', 'audio-watch'):
                with self.subTest(command=command), self.assertRaises(ValueError):
                    passthrough.main([command])
            with self.assertRaises(ValueError):
                passthrough.main(['audio-pcm', '48000'])


if __name__ == '__main__':
    unittest.main()
