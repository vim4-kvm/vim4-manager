#!/usr/bin/env python3
"""Offline GPU helper cost breakdown; never enables real GPU profiling.

Run in the Linux VM with --baseline pointing to the pre-optimization helper.
The synthetic proc tree has one DRM descriptor per process. No service changes.
"""
import argparse
import json
from pathlib import Path
import resource
import statistics
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--native-test', type=Path, required=True, help='Linux board test binary (go test -c ./internal/board)')
    parser.add_argument('--manager', type=Path, required=True, help='Linux manager binary')
    parser.add_argument('--samples', type=int, default=20)
    parser.add_argument('--processes', type=int, default=100)
    parser.add_argument('--fds', type=int, default=100)
    args = parser.parse_args()
    if min(args.samples, args.processes, args.fds) <= 0:
        parser.error('counts must be positive')
    current = Path(__file__).with_name('vim4-manager-helper').resolve()
    board = current.parents[2] / 'board'
    child = '''import sys
sys.path.insert(0, sys.argv[1])
source = open(sys.argv[2]).read()
scope = {'__name__': 'benchmark'}
exec(compile(source, sys.argv[2], 'exec'), scope)
if sys.argv[3] == 'scan':
    scope['gpu_snapshot'](scope['Path'](sys.argv[4]))
'''
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        profiling = root / 'sys/bus/platform/drivers/panfrost/test.gpu/profiling'
        profiling.parent.mkdir(parents=True)
        profiling.write_text('1')
        for pid in range(args.processes):
            process = root / f'proc/{pid + 100}'
            (process / 'fd').mkdir(parents=True)
            (process / 'fdinfo').mkdir()
            for fd in range(args.fds):
                (process / 'fd' / str(fd)).symlink_to('/dev/dri/renderD128' if fd == 0 else '/dev/null')
                (process / 'fdinfo' / str(fd)).write_text(
                    f'drm-driver: panfrost\ndrm-client-id: {pid}\n'
                    'drm-engine-fragment: 100 ns\ndrm-engine-vertex-tiler: 50 ns\n'
                    if fd == 0 else 'pos: 0\nflags: 0100000\n')
        commands = {'sudo': ['sudo', '-n', '/bin/true'],
                    'python': [sys.executable, '-c', 'pass'],
                    'sudo_python': ['sudo', '-n', sys.executable, '-c', 'pass']}
        for name, helper, scan in (
                ('old_import', args.baseline.resolve(), 'none'),
                ('old_scan', args.baseline.resolve(), 'scan'),
                ):
            commands[name] = ['sudo', '-n', sys.executable, '-c', child,
                              str(board), str(helper), scan, str(root)]
        commands['native_empty'] = ['sudo', '-n', str(args.manager.resolve()), 'gpu-snapshot']
        commands['native_scan'] = ['sudo', '-n', 'env', f'VIM4_GPU_BENCH_ROOT={root}',
                                   str(args.native_test.resolve()), '-test.run=^TestGPUSnapshotBenchmarkProbe$']
        report = dict(processes=args.processes, fds_per_process=args.fds, samples=args.samples)
        for name, command in commands.items():
            walls, cpus = [], []
            for _ in range(args.samples):
                before = resource.getrusage(resource.RUSAGE_CHILDREN)
                start = time.monotonic()
                subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
                walls.append(1000 * (time.monotonic() - start))
                after = resource.getrusage(resource.RUSAGE_CHILDREN)
                cpus.append(1000 * (after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime))
            report[name] = dict(cpu_median_ms=statistics.median(cpus),
                                wall_median_ms=statistics.median(walls), wall_max_ms=max(walls))
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
