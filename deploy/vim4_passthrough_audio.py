"""Independent vendor HDMI PCM bridge; never opens the KVM capture endpoint."""
import ctypes
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import tempfile
import time


RUNTIME = Path('/run/vim4-passthrough')
CAPTURE = b'hw:CARD=AMLAUGESOUND,DEV=6'
PLAYBACK = b'hw:CARD=AMLAUGESOUND,DEV=1'
ROUTES = {'Audio In Source': 8, 'HDMITX Audio Source Select': 0}
ISOLATED_RESAMPLE = {'Hardware resample enable': 0, 'Hw resample module': 0}


def atomic_json(path, value):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def load(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


class PCM:
    def __init__(self):
        self.alsa = ctypes.CDLL('libasound.so.2')
        pointer = ctypes.c_void_p
        frames = ctypes.c_ulong
        declarations = {
            'snd_pcm_open': [ctypes.POINTER(pointer), ctypes.c_char_p, ctypes.c_int, ctypes.c_int],
            'snd_pcm_hw_params_malloc': [ctypes.POINTER(pointer)],
            'snd_pcm_hw_params_any': [pointer, pointer],
            'snd_pcm_hw_params_set_access': [pointer, pointer, ctypes.c_uint],
            'snd_pcm_hw_params_set_format': [pointer, pointer, ctypes.c_uint],
            'snd_pcm_hw_params_set_channels': [pointer, pointer, ctypes.c_uint],
            'snd_pcm_hw_params_set_rate_near': [pointer, pointer, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_int)],
            'snd_pcm_hw_params_set_period_size_near': [pointer, pointer, ctypes.POINTER(frames), ctypes.POINTER(ctypes.c_int)],
            'snd_pcm_hw_params_set_buffer_size_near': [pointer, pointer, ctypes.POINTER(frames)],
            'snd_pcm_hw_params_get_period_size': [pointer, ctypes.POINTER(frames), ctypes.POINTER(ctypes.c_int)],
            'snd_pcm_hw_params_get_buffer_size': [pointer, ctypes.POINTER(frames)],
            'snd_pcm_hw_params': [pointer, pointer],
            'snd_pcm_hw_params_free': [pointer],
            'snd_pcm_sw_params_malloc': [ctypes.POINTER(pointer)],
            'snd_pcm_sw_params_current': [pointer, pointer],
            'snd_pcm_sw_params_set_start_threshold': [pointer, pointer, frames],
            'snd_pcm_sw_params': [pointer, pointer],
            'snd_pcm_sw_params_free': [pointer],
            'snd_pcm_readi': [pointer, pointer, frames],
            'snd_pcm_writei': [pointer, pointer, frames],
            'snd_pcm_delay': [pointer, ctypes.POINTER(ctypes.c_long)],
            'snd_pcm_drain': [pointer],
            'snd_pcm_drop': [pointer],
            'snd_pcm_close': [pointer],
        }
        for name, arguments in declarations.items():
            getattr(self.alsa, name).argtypes = arguments
        self.alsa.snd_pcm_readi.restype = ctypes.c_long
        self.alsa.snd_pcm_writei.restype = ctypes.c_long
        self.handles = []

    def check(self, result):
        if result < 0:
            raise OSError(-result, 'HDMI PCM operation failed')
        return result

    def acquire(self, device, stream):
        handle = ctypes.c_void_p()
        self.check(self.alsa.snd_pcm_open(ctypes.byref(handle), device, stream, 0))
        self.handles.append(handle)
        return handle

    def configure(self, handle, stream, sample_rate):
        params = ctypes.c_void_p()
        self.check(self.alsa.snd_pcm_hw_params_malloc(ctypes.byref(params)))
        try:
            self.check(self.alsa.snd_pcm_hw_params_any(handle, params))
            self.check(self.alsa.snd_pcm_hw_params_set_access(handle, params, 3))
            self.check(self.alsa.snd_pcm_hw_params_set_format(handle, params, 2))
            self.check(self.alsa.snd_pcm_hw_params_set_channels(handle, params, 2))
            rate, direction = ctypes.c_uint(sample_rate), ctypes.c_int()
            self.check(self.alsa.snd_pcm_hw_params_set_rate_near(handle, params, ctypes.byref(rate), ctypes.byref(direction)))
            period, buffer = ctypes.c_ulong(256), ctypes.c_ulong(2048)
            self.check(self.alsa.snd_pcm_hw_params_set_period_size_near(handle, params, ctypes.byref(period), ctypes.byref(direction)))
            self.check(self.alsa.snd_pcm_hw_params_set_buffer_size_near(handle, params, ctypes.byref(buffer)))
            self.check(self.alsa.snd_pcm_hw_params(handle, params))
            self.check(self.alsa.snd_pcm_hw_params_get_period_size(params, ctypes.byref(period), ctypes.byref(direction)))
            self.check(self.alsa.snd_pcm_hw_params_get_buffer_size(params, ctypes.byref(buffer)))
            if rate.value != sample_rate or period.value != 256 or buffer.value != 2048:
                raise ValueError('HDMI PCM requires an exact rate and whole DMA periods')
        finally:
            self.alsa.snd_pcm_hw_params_free(params)
        if stream == 0:
            software = ctypes.c_void_p()
            self.check(self.alsa.snd_pcm_sw_params_malloc(ctypes.byref(software)))
            try:
                self.check(self.alsa.snd_pcm_sw_params_current(handle, software))
                self.check(self.alsa.snd_pcm_sw_params_set_start_threshold(handle, software, 1536))
                self.check(self.alsa.snd_pcm_sw_params(handle, software))
            finally:
                self.alsa.snd_pcm_sw_params_free(software)

    def write(self, handle, samples, count):
        offset = 0
        while offset < count:
            written = self.check(self.alsa.snd_pcm_writei(handle,
                ctypes.byref(samples, offset * 4), count - offset))
            if written == 0:
                raise OSError('HDMI PCM playback made no progress')
            offset += written

    def close(self):
        for handle in reversed(self.handles):
            self.alsa.snd_pcm_close(handle)
        self.handles.clear()

    def drop(self):
        for handle in reversed(self.handles):
            self.alsa.snd_pcm_drop(handle)


def bridge(sample_rate):
    if sample_rate not in (44100, 48000):
        raise ValueError('Unsupported HDMI PCM rate')
    pcm = PCM()
    stopping = False

    def stop(unused_signal, unused_frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    samples = (ctypes.c_short * 512)()
    total, faded = 0, 0
    crossings, window_frames, last_sample = 0, 0, 0
    last_samples = [0, 0]
    previous = time.monotonic()
    routes = MixerRoutes()
    owns_endpoints = False
    try:
        capture = pcm.acquire(CAPTURE, 1)
        playback = pcm.acquire(PLAYBACK, 0)
        owns_endpoints = True
        routes.apply(True)
        pcm.configure(capture, 1, sample_rate)
        pcm.configure(playback, 0, sample_rate)
        while not stopping:
            count = pcm.alsa.snd_pcm_readi(capture, samples, 256)
            if stopping and count == -errno.EINTR:
                break
            pcm.check(count)
            if count == 0:
                raise OSError('HDMI PCM capture made no progress')
            for frame in range(min(count, max(0, 512 - faded))):
                gain = (faded + frame) / 512
                samples[frame * 2] = int(samples[frame * 2] * gain)
                samples[frame * 2 + 1] = int(samples[frame * 2 + 1] * gain)
            faded += count
            for frame in range(count):
                current = samples[frame * 2]
                crossings += int(last_sample < 0 <= current)
                last_sample = current
            window_frames += count
            pcm.write(playback, samples, count)
            last_samples = [samples[(count - 1) * 2 + channel] for channel in (0, 1)]
            total += count
            now = time.monotonic()
            if now - previous >= .5:
                capture_delay, playback_delay = ctypes.c_long(), ctypes.c_long()
                pcm.check(pcm.alsa.snd_pcm_delay(capture, ctypes.byref(capture_delay)))
                pcm.check(pcm.alsa.snd_pcm_delay(playback, ctypes.byref(playback_delay)))
                atomic_json(RUNTIME / 'audio-pcm.json', {
                    'heartbeat': now, 'pid': os.getpid(), 'rate': sample_rate, 'frames': total,
                    'captureDelayFrames': capture_delay.value, 'playbackDelayFrames': playback_delay.value,
                    'peak': max(abs(value) for value in samples[:count * 2]),
                    'rms': math.sqrt(sum(value * value for value in samples[:count * 2]) / (count * 2)),
                    'zeroCrossingHz': crossings * sample_rate / window_frames,
                })
                crossings, window_frames = 0, 0
                previous = now
        for frame in range(256):
            for channel in (0, 1):
                samples[frame * 2 + channel] = int(last_samples[channel] * (255 - frame) / 256)
        pcm.write(playback, samples, 256)
        pcm.alsa.snd_pcm_drain(playback)
    finally:
        try:
            pcm.drop()
            if owns_endpoints:
                routes.apply(False)
        finally:
            pcm.close()


class MixerRoutes:
    def __init__(self, root=Path('/'), run=subprocess.run):
        self.root, self.run = root, run

    def path(self, path):
        return self.root / str(path).lstrip('/')

    def mixer(self, name, value=None):
        command = ['amixer', '-c', 'AMLAUGESOUND', 'cget' if value is None else 'cset', f'name={name}']
        if value is not None:
            command.append(str(value))
        result = self.run(command, check=True, capture_output=True, text=True, timeout=2)
        selected = re.search(r': values=(\d+)\s*$', result.stdout)
        if not selected:
            raise ValueError('Invalid HDMI mixer readback')
        return int(selected[1])

    def apply(self, enable):
        saved_path = self.path(RUNTIME / 'audio-before.json')
        saved = load(saved_path)
        if enable and saved is None:
            saved = {name: self.mixer(name) for name in ROUTES}
            if self.mixer('Hw resample module') == 8:
                saved.update({name: self.mixer(name) for name in ISOLATED_RESAMPLE})
            atomic_json(saved_path, saved)
        if saved is None:
            return
        if (set(saved) not in (set(ROUTES), set(ROUTES) | set(ISOLATED_RESAMPLE))
                or any(type(value) is not int or value < 0 or value > 15 for value in saved.values())):
            raise ValueError('Invalid saved HDMI audio routes')
        desired_routes = {name: value for name, value in ISOLATED_RESAMPLE.items() if name in saved} | ROUTES
        names = list(desired_routes) if enable else list(reversed(desired_routes))
        for name in names:
            desired = desired_routes[name]
            current = self.mixer(name)
            target = desired if enable else saved[name]
            if current != target and (enable or current == desired):
                self.mixer(name, target)
        if not enable:
            saved_path.unlink()


class AudioWorker:
    def __init__(self, root=Path('/'), run=subprocess.run, spawn=subprocess.Popen, clock=time.monotonic,
                 pcm_factory=PCM):
        self.root, self.spawn, self.clock = root, spawn, clock
        self.controls = MixerRoutes(root, run)
        self.pcm_factory = pcm_factory
        self.child = None
        self.rate = None
        self.pending = None
        self.retry_at = 0
        self.child_started = 0
        self.last_error = None
        self.last_cleanup_error = None

    def path(self, path):
        return self.root / str(path).lstrip('/')

    def stop(self):
        if self.child is not None:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=1)
            self.child = None
        self.rate = self.pending = None
        if self.path(RUNTIME / 'audio-before.json').exists():
            guard = self.pcm_factory()
            try:
                guard.acquire(CAPTURE, 1)
                guard.acquire(PLAYBACK, 0)
                self.controls.apply(False)
            finally:
                guard.close()

    def source_rate(self):
        before = self.controls.mixer('HDMIIN audio samplerate')
        pcm = self.controls.mixer('HDMIIN NONAUDIO') == 0
        channels = self.controls.mixer('HDMIIN audio channels')
        stable = self.controls.mixer('HDMIIN audio stable') == 1
        if before != self.controls.mixer('HDMIIN audio samplerate') or not stable:
            return None
        if not pcm or channels != 1 or before not in (2, 3):
            raise ValueError('Only stereo PCM at 44.1/48 kHz is qualified')
        return {2: 44100, 3: 48000}[before]

    def tick(self, request, video):
        state = video.get('state', {})
        enabled = request.get('audio', False) and request.get('enabled', False)
        if not enabled:
            self.stop()
            return 'off'
        if not state.get('supported') or self.clock() - video.get('heartbeat', 0) > 4:
            self.stop()
            return 'error'
        if not state.get('monitor', {}).get('audio'):
            self.stop()
            return 'unavailable'
        if state.get('state') != 'running' or not state.get('input', {}).get('audio'):
            self.stop()
            return 'waiting'
        endpoints = self.path('/proc/asound/pcm').read_text()
        if not re.search(r'^\d+-06: EXTN-', endpoints, re.M) or not re.search(r'^\d+-01: SPDIF-', endpoints, re.M):
            raise ValueError('Vendor HDMI audio endpoints do not match')
        source = self.controls.mixer('Audio In Source')
        if source not in (0, 8):
            raise ValueError('EXTN capture is configured for another input')
        rate = self.source_rate()
        capabilities = self.path('/sys/class/amhdmitx/amhdmitx0/aud_cap').read_text()
        line = next((line for line in capabilities.splitlines() if line.startswith('PCM,')), '')
        match = re.search(r'PCM, (\d+) ch, ([\d./]+) kHz', line)
        if rate is None or not match or int(match[1]) < 2 or rate not in {round(float(value) * 1000) for value in match[2].split('/')}:
            self.stop()
            return 'unavailable'
        if self.child is not None and (self.child.poll() is not None or self.rate != rate):
            failed = self.child.poll() is not None
            self.stop()
            if failed:
                self.retry_at = self.clock() + 5
                raise OSError('HDMI PCM bridge exited')
        if self.child is None:
            if self.clock() < self.retry_at:
                return 'error'
            if self.pending != rate:
                self.pending = rate
                return 'starting'
            if source == 0:
                self.controls.mixer('Audio In Source', 8)
            self.path(RUNTIME / 'audio-pcm.json').unlink(missing_ok=True)
            self.child = self.spawn(['/usr/libexec/vim4-passthrough', 'audio-pcm', str(rate)],
                                    stdin=subprocess.DEVNULL, start_new_session=True)
            self.child_started = self.clock()
            self.rate = rate
            return 'starting'
        stats = load(self.path(RUNTIME / 'audio-pcm.json'), {})
        if stats.get('pid') == self.child.pid and self.clock() - stats.get('heartbeat', 0) < 2 and stats.get('frames', 0) > 1536:
            return 'running'
        if self.clock() - self.child_started > 4:
            raise OSError('HDMI PCM bridge stopped progressing')
        return 'starting'

    def cycle(self, request, video):
        try:
            state = self.tick(request, video)
            self.last_error = None
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            if str(error) != self.last_error:
                print(str(error), file=sys.stderr, flush=True)
                self.last_error = str(error)
            try:
                self.stop()
            except (OSError, ValueError, subprocess.SubprocessError) as cleanup:
                if str(cleanup) != self.last_cleanup_error:
                    print(str(cleanup), file=sys.stderr, flush=True)
                    self.last_cleanup_error = str(cleanup)
            self.retry_at = self.clock() + 5
            state = 'error'
        return {'revision': request.get('revision'), 'heartbeat': self.clock(), 'state': state}


def watch():
    if not platform.release().startswith('5.15.'):
        return
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    worker = AudioWorker()

    def stopping(unused_signal, unused_frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGINT, stopping)
    with (RUNTIME / 'audio.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            while True:
                request = load(RUNTIME / 'request.json', {})
                video = load(RUNTIME / 'state.json', {})
                atomic_json(RUNTIME / 'audio-state.json', worker.cycle(request, video))
                time.sleep(.5)
        finally:
            worker.stop()
