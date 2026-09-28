#!/usr/bin/env python3
"""lagprobe — catch what is going on when GNOME feels laggy.

Samples the system at high frequency while you use the desktop, then reports
what lined up with any stalls:

  * gnome-shell main-loop blocking (a D-Bus round trip into gnome-shell every
    25 ms; if the shell's main thread is busy — JS, extensions, GC, compositor
    work — the reply is late)
  * what that main thread was doing during a stall: running (CPU work) or
    asleep in the kernel, and on what (e.g. waiting on a Bluetooth device)
  * session-bus latency (control: separates "shell busy" from "whole system")
  * memory / IO / CPU pressure (PSI), swap-ins, major page faults, cache
    refaults, direct reclaim, compaction stalls
  * GPU busy % and shader clock
  * which processes were using CPU
  * gnome-shell messages and kernel warnings from the journal

Read-only: it changes no settings.

Usage:
  lagprobe.py [--duration SEC] [--threshold MS]

  While it runs, use the desktop normally. Whenever you feel a lag, switch to
  the terminal and press Enter (optionally type a note first). Ctrl+C stops
  and prints the report. Everything is also saved under
  ~/.cache/lagprobe/<timestamp>/.
"""

import argparse
import csv
import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time
from datetime import datetime

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

CLK = os.sysconf('SC_CLK_TCK')
NCPU = os.cpu_count() or 1
SAMPLE_S = 0.100
PING_S = 0.025
PROC_S = 1.0
THREAD_S = 0.005

# Kernel wait channels that mean "idle in the main loop", not "blocked".
IDLE_WCHAN = ('do_epoll_wait', 'do_sys_poll', 'do_poll', 'ep_poll', '0', '')
# Known wait channels, in plain words.
WCHAN_HINTS = {
    'uhid': 'a Bluetooth input device (keyboard/mouse/pen) — e.g. reading its battery via sysfs',
    'hid': 'a HID device answering a report request',
    'futex': 'a lock or another thread (a synchronous call waiting for a reply)',
    'pipe': 'a pipe — e.g. waiting on a subprocess',
    'nvme': 'the SSD',
    'blk': 'the disk',
    'acpi': 'ACPI firmware',
    'drm': 'the GPU driver',
    'amdgpu': 'the GPU driver',
    'i2c': 'an I2C device (sensor, touch controller)',
}

VMSTAT_KEYS = (
    'pswpin', 'pswpout', 'pgmajfault', 'workingset_refault_anon',
    'workingset_refault_file', 'pgsteal_direct', 'allocstall_normal',
    'allocstall_movable', 'compact_stall',
)


# ---------------------------------------------------------------- readers

def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def psi(kind):
    some = full = 0
    for line in (read(f'/proc/pressure/{kind}') or '').splitlines():
        v = int(line.rsplit('total=', 1)[1])
        if line.startswith('some'):
            some = v
        else:
            full = v
    return some, full  # microseconds


def vmstat():
    d = {}
    for line in read('/proc/vmstat').splitlines():
        k, v = line.split()
        if k in VMSTAT_KEYS:
            d[k] = int(v)
    return d


def cpu_total():
    vals = list(map(int, read('/proc/stat').split('\n', 1)[0].split()[1:9]))
    return sum(vals), vals[3] + vals[4]  # total, idle+iowait


def proc_ticks(pid):
    s = read(f'/proc/{pid}/stat')
    if not s:
        return None
    rest = s[s.rfind(')') + 2:].split()
    return int(rest[11]) + int(rest[12])


def meminfo():
    d = {}
    for line in read('/proc/meminfo').splitlines():
        k, v = line.split(':', 1)
        d[k] = int(v.split()[0])
    return d


def pid_of(name):
    for p in os.listdir('/proc'):
        if p.isdigit() and (read(f'/proc/{p}/comm') or '').strip() == name:
            return int(p)
    return None


def find_gpu():
    for card in sorted(os.listdir('/sys/class/drm')):
        d = f'/sys/class/drm/{card}/device'
        if re.fullmatch(r'card\d+', card) and os.path.exists(f'{d}/gpu_busy_percent'):
            return d
    return None


def gpu_state(d):
    if not d:
        return -1, -1
    busy = read(f'{d}/gpu_busy_percent')
    m = re.search(r'(\d+)Mhz \*', read(f'{d}/pp_dpm_sclk') or '')
    return (int(busy) if busy and busy.strip().isdigit() else -1,
            int(m.group(1)) if m else -1)


def sh(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5,
                              shell=isinstance(cmd, str)).stdout.strip()
    except Exception as e:  # noqa: BLE001
        return f'?({e.__class__.__name__})'


# ---------------------------------------------------------------- probe

class Probe:
    def __init__(self, threshold_ms):
        self.thr = threshold_ms
        self.t0 = time.monotonic()
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.samples = []   # dicts, every 100 ms
        self.pings = []     # (t_end, shell_ms, bus_ms)
        self.procs = []     # (t, [(pct, comm, pid)])
        self.journal = []   # (t, source, message)
        self.marks = []     # (t, note)
        self.thread = []    # (t, state, wchan) of gnome-shell's main thread
        self.gpu = find_gpu()
        self.shell_pid = pid_of('gnome-shell')
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.jproc = None

    def rel(self, t):
        return t - self.t0

    def say(self, msg):
        with self.lock:
            print(f'[{self.rel(time.monotonic()):7.1f}s] {msg}', flush=True)

    # --- gnome-shell main-loop responsiveness
    def ping_loop(self):
        get_args = GLib.Variant('(ss)', ('org.gnome.Shell', 'ShellVersion'))
        nxt = time.monotonic()
        while not self.stop.is_set():
            a = time.monotonic()
            try:
                self.bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                                   'org.freedesktop.DBus', 'GetId', None, None,
                                   Gio.DBusCallFlags.NONE, 5000, None)
            except GLib.Error:
                pass
            b = time.monotonic()
            try:
                self.bus.call_sync('org.gnome.Shell', '/org/gnome/Shell',
                                   'org.freedesktop.DBus.Properties', 'Get', get_args,
                                   None, Gio.DBusCallFlags.NONE, 5000, None)
            except GLib.Error:
                pass
            c = time.monotonic()
            bus_ms, shell_ms = (b - a) * 1000, (c - b) * 1000
            self.pings.append((c, shell_ms, bus_ms))
            if shell_ms >= self.thr:
                frames = shell_ms / 16.7
                doing = describe_thread(thread_window(self.thread, b, c))
                self.say(f'gnome-shell blocked {shell_ms:5.0f} ms  (~{frames:.0f} frames at 60 Hz; '
                         f'bus {bus_ms:.1f} ms) — {doing}')
            elif bus_ms >= self.thr:
                self.say(f'session bus slow {bus_ms:.0f} ms (whole session stalled?)')
            nxt += PING_S
            self.stop.wait(max(0.0, nxt - time.monotonic()))
            if time.monotonic() - nxt > 1:
                nxt = time.monotonic()

    # --- gnome-shell main thread: running, or asleep in the kernel on what
    def thread_loop(self):
        if not self.shell_pid:
            return
        stat, wchan = f'/proc/{self.shell_pid}/stat', f'/proc/{self.shell_pid}/wchan'
        while not self.stop.wait(THREAD_S):
            s = read(stat)
            if not s:
                return
            self.thread.append((time.monotonic(), s[s.rfind(')') + 2], (read(wchan) or '').strip()))

    # --- system counters every 100 ms
    def sample_loop(self):
        prev = None
        nxt = time.monotonic() + SAMPLE_S
        while not self.stop.is_set():
            self.stop.wait(max(0.0, nxt - time.monotonic()))
            now = time.monotonic()
            late_ms = (now - nxt) * 1000
            nxt += SAMPLE_S
            if late_ms > 1000:
                nxt = now + SAMPLE_S
            cur = {
                'mem': psi('memory'), 'io': psi('io'), 'cpu': psi('cpu'),
                'vm': vmstat(), 'stat': cpu_total(),
                'shell': proc_ticks(self.shell_pid) if self.shell_pid else None,
            }
            if prev is not None:
                dt = now - prev['t']
                tot = cur['stat'][0] - prev['stat'][0]
                idle = cur['stat'][1] - prev['stat'][1]
                vmd = {k: cur['vm'].get(k, 0) - prev['vm'].get(k, 0) for k in VMSTAT_KEYS}
                shell_pct = -1
                if cur['shell'] is not None and prev['shell'] is not None:
                    shell_pct = (cur['shell'] - prev['shell']) / CLK / dt * 100
                busy, sclk = gpu_state(self.gpu)
                mi = meminfo()
                s = {
                    't': now, 'late_ms': late_ms,
                    'mem_some_ms': (cur['mem'][0] - prev['mem'][0]) / 1000,
                    'mem_full_ms': (cur['mem'][1] - prev['mem'][1]) / 1000,
                    'io_some_ms': (cur['io'][0] - prev['io'][0]) / 1000,
                    'io_full_ms': (cur['io'][1] - prev['io'][1]) / 1000,
                    'cpu_some_ms': (cur['cpu'][0] - prev['cpu'][0]) / 1000,
                    'swapin': vmd['pswpin'], 'swapout': vmd['pswpout'],
                    'majflt': vmd['pgmajfault'],
                    'refault_anon': vmd['workingset_refault_anon'],
                    'refault_file': vmd['workingset_refault_file'],
                    'direct_reclaim': vmd['pgsteal_direct'] + vmd['allocstall_normal'] + vmd['allocstall_movable'],
                    'compact_stall': vmd['compact_stall'],
                    'cpu_busy_pct': (tot - idle) / tot * 100 if tot else 0,
                    'shell_cpu_pct': shell_pct,
                    'gpu_busy': busy, 'sclk_mhz': sclk,
                    'mem_avail_mb': mi.get('MemAvailable', 0) // 1024,
                    'swap_used_mb': (mi.get('SwapTotal', 0) - mi.get('SwapFree', 0)) // 1024,
                }
                self.samples.append(s)
                self.flag(s)
            cur['t'] = now
            prev = cur

    def flag(self, s):
        bits = []
        if s['mem_some_ms'] >= 2:
            bits.append(f"memory stall {s['mem_some_ms']:.0f} ms")
        if s['swapin']:
            bits.append(f"swap-in {s['swapin']} pages")
        if s['direct_reclaim']:
            bits.append(f"direct reclaim {s['direct_reclaim']}")
        if s['compact_stall']:
            bits.append(f"compaction stall {s['compact_stall']}")
        if s['majflt'] >= 50:
            bits.append(f"{s['majflt']} major faults")
        if s['io_some_ms'] >= 20:
            bits.append(f"IO wait {s['io_some_ms']:.0f} ms")
        if s['cpu_some_ms'] >= 30:
            bits.append(f"CPU contention {s['cpu_some_ms']:.0f} ms")
        if s['late_ms'] >= 50:
            bits.append(f"sampler woke {s['late_ms']:.0f} ms late")
        if bits:
            self.say('system: ' + ', '.join(bits))

    # --- per-process CPU every second
    def proc_loop(self):
        prev, prev_t = {}, time.monotonic()
        while not self.stop.wait(PROC_S):
            now, cur, names = time.monotonic(), {}, {}
            for p in os.listdir('/proc'):
                if not p.isdigit():
                    continue
                t = proc_ticks(p)
                if t is not None:
                    cur[p] = t
            dt = now - prev_t
            top = []
            for p, t in cur.items():
                d = t - prev.get(p, t)
                if d > 0:
                    top.append((d / CLK / dt * 100, p))
            top.sort(reverse=True)
            for _, p in top[:6]:
                names[p] = (read(f'/proc/{p}/comm') or '?').strip()
            self.procs.append((now, [(round(pct, 1), names[p], int(p)) for pct, p in top[:6]]))
            prev, prev_t = cur, now

    # --- journal: gnome-shell + kernel warnings
    def journal_loop(self):
        try:
            self.jproc = subprocess.Popen(['journalctl', '-f', '-n', '0', '-o', 'json'],
                                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                          text=True)
        except OSError:
            return
        for line in self.jproc.stdout:
            if self.stop.is_set():
                break
            try:
                e = json.loads(line)
            except ValueError:
                continue
            msg = e.get('MESSAGE', '')
            if isinstance(msg, list):
                msg = bytes(msg).decode('utf-8', 'replace')
            prio = int(e.get('PRIORITY', 6))
            comm = e.get('_COMM', '')
            ident = e.get('SYSLOG_IDENTIFIER', '')
            if e.get('_TRANSPORT') == 'kernel':
                if prio > 4 and 'amdgpu' not in msg and 'drm' not in msg:
                    continue
                src = 'kernel'
            elif comm in ('gnome-shell', 'gjs') or ident in ('gnome-shell', 'gjs'):
                src = 'gnome-shell'
            elif prio <= 3:
                src = ident or comm or '?'
            else:
                continue
            try:
                t = int(e['__MONOTONIC_TIMESTAMP']) / 1e6
            except (KeyError, ValueError):
                t = time.monotonic()
            msg = msg.strip().replace('\n', ' ')[:300]
            self.journal.append((t, src, msg))
            self.say(f'log[{src}]: {msg[:160]}')

    def run(self, duration):
        threads = [threading.Thread(target=f, daemon=True)
                   for f in (self.ping_loop, self.sample_loop, self.proc_loop, self.thread_loop,
                             self.journal_loop)]
        for th in threads:
            th.start()

        def reader():
            for line in sys.stdin:
                t = time.monotonic()
                self.marks.append((t, line.strip()))
                self.say(f'*** LAG MARK #{len(self.marks)}' + (f': {line.strip()}' if line.strip() else ''))

        if sys.stdin.isatty():
            threading.Thread(target=reader, daemon=True).start()
        end = time.monotonic() + duration if duration else None
        try:
            while not self.stop.wait(0.2):
                if end and time.monotonic() >= end:
                    break
        except KeyboardInterrupt:
            print()
        self.stop.set()
        if self.jproc:
            self.jproc.terminate()
        for th in threads[:4]:
            th.join(timeout=6)


# ---------------------------------------------------------------- report

def thread_window(samples, a, b):
    """Thread samples in [a, b]; the list is time-ordered, so scan from the end."""
    out = []
    for t, st, w in reversed(samples):
        if t < a:
            break
        if t <= b:
            out.append((st, w))
    return out


def thread_summary(win):
    """(running_share, dominant blocking wchan or None, its share)."""
    if not win:
        return None, None, 0
    running = sum(1 for st, _ in win if st == 'R') / len(win)
    waits = {}
    for st, w in win:
        if st in ('S', 'D') and w not in IDLE_WCHAN:
            waits[w] = waits.get(w, 0) + 1
    if not waits:
        return running, None, 0
    w, n = max(waits.items(), key=lambda x: x[1])
    return running, w, n / len(win)


def wchan_hint(w):
    for key, hint in WCHAN_HINTS.items():
        if key in w:
            return hint
    return None


def describe_thread(win):
    running, w, share = thread_summary(win)
    if running is None:
        return 'main thread not sampled'
    if w and share >= 0.5:
        hint = wchan_hint(w)
        return f'main thread asleep in kernel `{w}`' + (f' = waiting on {hint}' if hint else '')
    if running >= 0.5:
        return 'main thread running (CPU work: JS / GC / compositor)'
    return 'main thread mostly idle-waiting'

def window(rows, a, b, key=lambda r: r['t']):
    return [r for r in rows if a <= key(r) <= b]


def stalls_from(pings, thr):
    """Merge over-threshold pings into stall episodes: (start, end, worst_ms, bus_ms)."""
    out = []
    for t, ms, bus in pings:
        if ms < thr:
            continue
        start = t - ms / 1000
        if out and start <= out[-1][1] + 0.1:
            s, e, w, bw = out[-1]
            out[-1] = (min(s, start), t, max(w, ms), max(bw, bus))
        else:
            out.append((start, t, ms, bus))
    return out


def find_period(starts, tol=0.15):
    """Largest period (1–10 s) that >= 80% of stall starts line up on, allowing
    for skipped ticks (a timer whose work is sometimes fast enough to not stall)."""
    if len(starts) < 4:
        return None
    best = None
    for i in range(100, 1001, 5):
        P = i / 100
        phases = [s % P for s in starts]
        hits = max(sum(1 for q in phases if min(abs(q - ph), P - abs(q - ph)) <= tol) for ph in phases)
        if hits >= 0.8 * len(starts):
            best = P
    return best


def classify(ctx, thr, stall_ms):
    running, w, wshare = ctx['thread']
    if w and wshare >= 0.5:
        hint = wchan_hint(w)
        return f'SHELL WAITING in kernel on `{w}`' + (f' ({hint})' if hint else '')
    # a factor only counts if it covers a meaningful share of the stall
    share = max(10.0, stall_ms * 0.25)
    if ctx['swapin'] or ctx['mem_some_ms'] >= min(share, 20) or ctx['direct_reclaim']:
        return 'MEMORY (reclaim / swap-in)'
    if ctx['io_some_ms'] >= share or ctx['majflt'] >= 50:
        return 'DISK (waiting on reads)'
    if ctx['bus_ms'] >= thr / 2 or ctx['late_ms'] >= 30:
        return 'WHOLE SYSTEM stalled (not just the shell)'
    if ctx['cpu_some_ms'] >= share:
        return 'CPU contention (runnable tasks waiting)'
    if running is not None and running >= 0.5:
        return 'GNOME-SHELL itself busy on CPU (JS / extensions / GC / compositor)'
    return 'GNOME-SHELL stalled, cause unclear (see main-thread line)'


def context(p, a, b, bus_ms=0.0):
    ss = window(p.samples, a - 0.15, b + 0.15)
    ctx = {k: sum(s[k] for s in ss) for k in
           ('mem_some_ms', 'io_some_ms', 'cpu_some_ms', 'swapin', 'majflt',
            'refault_anon', 'refault_file', 'direct_reclaim', 'compact_stall')}
    ctx['late_ms'] = max((s['late_ms'] for s in ss), default=0)
    ctx['shell_cpu'] = max((s['shell_cpu_pct'] for s in ss), default=-1)
    ctx['gpu_busy'] = max((s['gpu_busy'] for s in ss), default=-1)
    sclks = [s['sclk_mhz'] for s in ss if s['sclk_mhz'] > 0]
    ctx['sclk'] = f'{min(sclks)}-{max(sclks)}' if sclks else '?'
    ctx['bus_ms'] = bus_ms
    ctx['thread'] = thread_summary(thread_window(p.thread, a, b))
    after = [pr for pr in p.procs if pr[0] >= b]
    ctx['procs'] = after[0][1] if after else (p.procs[-1][1] if p.procs else [])
    ctx['logs'] = [j for j in p.journal if a - 1 <= j[0] <= b + 1]
    return ctx


def fmt_ctx(p, ctx):
    lines = [
        f"      mem-stall {ctx['mem_some_ms']:.0f}ms  io-wait {ctx['io_some_ms']:.0f}ms  "
        f"cpu-wait {ctx['cpu_some_ms']:.0f}ms  swap-in {ctx['swapin']}  majflt {ctx['majflt']}  "
        f"refault {ctx['refault_anon']}/{ctx['refault_file']} (anon/file)",
        f"      gnome-shell CPU {ctx['shell_cpu']:.0f}%  GPU busy {ctx['gpu_busy']}%  "
        f"GPU clock {ctx['sclk']} MHz  sampler-late {ctx['late_ms']:.0f}ms",
    ]
    running, w, wshare = ctx['thread']
    if running is not None:
        lines.append(f"      main thread: running {running * 100:.0f}% of the stall" +
                     (f", asleep in `{w}` {wshare * 100:.0f}%" if w else ''))
    if ctx['procs']:
        lines.append('      busy procs: ' + ', '.join(f'{c}({pid}) {pct:.0f}%' for pct, c, pid in ctx['procs'][:5]))
    for t, src, msg in ctx['logs'][:4]:
        lines.append(f'      log @{p.rel(t):.1f}s [{src}] {msg[:150]}')
    return lines


def report(p, header):
    out = list(header)
    dur = p.rel(time.monotonic())
    thr = p.thr
    shell = [ms for _, ms, _ in p.pings]
    bus = [b for _, _, b in p.pings]
    stalls = stalls_from(p.pings, thr)
    S = p.samples

    out += ['', '=' * 78, f'RESULTS  ({dur:.0f}s, {len(p.pings)} shell pings, {len(S)} samples, '
            f'{len(p.marks)} lag marks)', '=' * 78]
    if shell:
        q = statistics.quantiles(shell, n=100) if len(shell) > 2 else [0] * 99
        out.append(f'gnome-shell reply time: median {statistics.median(shell):.1f}ms  '
                   f'p99 {q[98]:.1f}ms  max {max(shell):.0f}ms')
        out.append(f'session bus reply time: median {statistics.median(bus):.1f}ms  max {max(bus):.0f}ms')
    blocked = sum(e - s for s, e, _, _ in stalls)
    out.append(f'shell stalls >= {thr}ms: {len(stalls)}  (total {blocked * 1000:.0f}ms blocked)')
    if S:
        tot = lambda k: sum(s[k] for s in S)  # noqa: E731
        out.append(f"totals: mem-stall {tot('mem_some_ms'):.0f}ms  io-wait {tot('io_some_ms'):.0f}ms  "
                   f"cpu-wait {tot('cpu_some_ms'):.0f}ms  swap-in {tot('swapin')}  swap-out {tot('swapout')}  "
                   f"majflt {tot('majflt')}  direct-reclaim {tot('direct_reclaim')}  compaction {tot('compact_stall')}")
        out.append(f"memory available: min {min(s['mem_avail_mb'] for s in S)} MB, "
                   f"swap used max {max(s['swap_used_mb'] for s in S)} MB")
        sclks = [s['sclk_mhz'] for s in S if s['sclk_mhz'] > 0]
        if sclks:
            idle_share = sum(1 for c in sclks if c == min(sclks)) / len(sclks) * 100
            out.append(f'GPU clock: {min(sclks)}-{max(sclks)} MHz, at lowest step {idle_share:.0f}% of the time')

    # periodicity: a timer somewhere (often an extension) blocking the shell
    period = find_period([s for s, _, _, _ in stalls])
    if period:
        out.append(f'!! stalls start on a ~{period:.1f}s beat — looks like a timer, '
                   f'e.g. an extension polling on the main loop')

    if stalls:
        out += ['', f'WORST SHELL STALLS (of {len(stalls)}):']
        verdicts = {}
        for s, e, worst, bms in sorted(stalls, key=lambda x: -x[2])[:12]:
            ctx = context(p, s, e, bms)
            v = classify(ctx, thr, worst)
            out.append(f'  @{p.rel(s):6.1f}s  {worst:5.0f}ms  -> {v}')
            out += fmt_ctx(p, ctx)
        for s, e, worst, bms in stalls:
            v = classify(context(p, s, e, bms), thr, worst)
            verdicts[v] = verdicts.get(v, 0) + 1
        out += ['', 'STALL CAUSES (all stalls):'] + [f'  {n:3d} x {v}' for v, n in
                                                     sorted(verdicts.items(), key=lambda x: -x[1])]

    if p.marks:
        out += ['', 'YOUR LAG MARKS (looking at the 5s before each Enter):']
        for i, (t, note) in enumerate(p.marks, 1):
            near = [st for st in stalls if t - 5 <= st[0] <= t]
            out.append(f'  #{i} @{p.rel(t):.1f}s' + (f' "{note}"' if note else '') +
                       f' — {len(near)} shell stall(s) in the 5s before')
            for s, e, worst, bms in near:
                ctx = context(p, s, e, bms)
                out.append(f'     @{p.rel(s):.1f}s {worst:.0f}ms -> {classify(ctx, thr, worst)}')
            if not near:
                ctx = context(p, t - 5, t)
                out.append('     gnome-shell stayed responsive -> lag was most likely the app you switched to')
                out.append('     repainting (background-throttled browser/Electron), or GPU clock ramp-up.')
                out += fmt_ctx(p, ctx)

    if p.procs:
        agg = {}
        for _, top in p.procs:
            for pct, c, _pid in top:
                agg[c] = agg.get(c, 0) + pct
        n = len(p.procs)
        out += ['', 'TOP CPU OVER THE RUN (avg % of one core): ' +
                ', '.join(f'{c} {v / n:.1f}%' for c, v in sorted(agg.items(), key=lambda x: -x[1])[:8])]
    if p.journal:
        out += ['', f'LOG MESSAGES ({len(p.journal)}):']
        out += [f'  @{p.rel(t):.1f}s [{src}] {m[:200]}' for t, src, m in p.journal[:30]]

    out += ['', 'HOW TO READ THIS:',
            '  * SHELL WAITING in kernel -> something on the shell thread (usually an extension)',
            '    is doing blocking I/O; the wait channel says on what. A beat points at a timer.',
            '  * GNOME-SHELL busy on CPU -> JS, garbage collection or compositor work.',
            '  * MEMORY / DISK verdicts -> RAM or IO really is involved at those moments.',
            '  * Marks with no shell stall -> the shell was fine; the app you switched to was slow',
            '    to repaint (or the GPU was ramping up from its lowest clock).']
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--duration', type=float, default=0, help='stop after SEC seconds (default: until Ctrl+C)')
    ap.add_argument('--threshold', type=float, default=34,
                    help='report shell replies slower than this many ms (default 34 = 2 frames at 60 Hz)')
    args = ap.parse_args()

    p = Probe(args.threshold)
    mi = meminfo()
    ext = sh(['gnome-extensions', 'list', '--enabled']).replace('\n', ', ')
    header = [
        f"lagprobe  {datetime.now():%Y-%m-%d %H:%M:%S}",
        f"kernel {os.uname().release}   {sh(['gnome-shell', '--version'])}   session {os.environ.get('XDG_SESSION_TYPE', '?')}",
        f"RAM {mi['MemTotal'] // 1024} MB, available {mi['MemAvailable'] // 1024} MB, "
        f"swap used {(mi['SwapTotal'] - mi['SwapFree']) // 1024} MB",
        f"swappiness {(read('/proc/sys/vm/swappiness') or '?').strip()}   "
        f"THP {(read('/sys/kernel/mm/transparent_hugepage/enabled') or '?').strip()}",
        f"power profile {sh(['powerprofilesctl', 'get'])}   EPP "
        f"{(read('/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference') or '?').strip()}   "
        f"GPU dpm {(read(p.gpu + '/power_dpm_force_performance_level') or '?').strip() if p.gpu else 'n/a'}",
        f"extensions: {ext}",
        f"gnome-shell pid {p.shell_pid}",
    ]
    print('\n'.join(header))
    print('-' * 78)
    print('Recording. Use the desktop and switch windows. When you feel a lag, come back here')
    print('and press Enter (optionally type a note first). Ctrl+C to stop and see the report.')
    print('-' * 78, flush=True)

    p.run(args.duration)

    lines = report(p, header)
    print('\n'.join(lines))

    cache = os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')
    rundir = os.path.join(cache, 'lagprobe', datetime.now().strftime('%Y%m%d-%H%M%S'))
    os.makedirs(rundir, exist_ok=True)
    with open(os.path.join(rundir, 'summary.txt'), 'w') as f:
        f.write('\n'.join(lines) + '\n')
    if p.samples:
        with open(os.path.join(rundir, 'samples.csv'), 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=list(p.samples[0].keys()))
            w.writeheader()
            for s in p.samples:
                w.writerow({**s, 't': round(p.rel(s['t']), 3)})
    with open(os.path.join(rundir, 'pings.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['t', 'shell_ms', 'bus_ms'])
        for t, ms, b in p.pings:
            w.writerow([round(p.rel(t), 3), round(ms, 2), round(b, 2)])
    with open(os.path.join(rundir, 'events.log'), 'w') as f:
        for t, note in p.marks:
            f.write(f'{p.rel(t):.2f} MARK {note}\n')
        for t, src, m in p.journal:
            f.write(f'{p.rel(t):.2f} LOG[{src}] {m}\n')
        for t, top in p.procs:
            f.write(f'{p.rel(t):.2f} PROCS ' + ', '.join(f'{c}({pid}) {pct}%' for pct, c, pid in top) + '\n')
    print(f'\nSaved to {rundir}/')


if __name__ == '__main__':
    main()
