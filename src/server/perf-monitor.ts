/**
 * What the daemon spends its time on, for the admin Health panel.
 *
 * Event-loop delay from perf_hooks; every child process the daemon forks,
 * counted by command (git subcommand, tmux subcommand, other) and whether it
 * ran synchronously (blocking the loop) with the time it blocked; and the
 * duration of the background jobs (`recordJob`). Kept as one-minute buckets
 * for the last 15 minutes. A sustained p99 above the threshold emits
 * `perf.lag` once per 5 minutes so the board can say the daemon is slow.
 */

import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { emit } from './event-bus.js';
import logger from './logger.js';

export const PERF_BUCKET_MS = 60_000;
export const PERF_BUCKETS = 15;
export const LAG_P99_MS = 500;
const LAG_ALERT_EVERY_MS = 5 * 60_000;

export interface SpawnBucket {
  at: number;
  /** command → count */
  spawns: Record<string, number>;
  sync_spawns: number;
  /** milliseconds the loop was blocked inside synchronous child processes */
  sync_blocked_ms: number;
}

export interface JobSample { name: string; ms: number; at: number }

export interface PerfSnapshot {
  at: string;
  uptime_s: number;
  loop_ms: { p50: number; p99: number; max: number; mean: number } | null;
  cpu_pct: number | null;
  rss_mb: number;
  last_minute: { spawns: Record<string, number>; sync_spawns: number; sync_blocked_ms: number };
  last_15_min: { spawns: Record<string, number>; sync_spawns: number; sync_blocked_ms: number };
  jobs: Record<string, { last_ms: number; last_at: string; max_ms: number; runs: number }>;
  lag_threshold_ms: number;
}

const buckets: SpawnBucket[] = [];
const jobs = new Map<string, { last_ms: number; last_at: number; max_ms: number; runs: number }>();
let histogram: IntervalHistogram | null = null;
let lastCpu: { usage: NodeJS.CpuUsage; at: number } | null = null;
let lastLagAlert = 0;
let lagTimer: ReturnType<typeof setInterval> | null = null;
let patched = false;

function bucket(now = Date.now()): SpawnBucket {
  const slot = Math.floor(now / PERF_BUCKET_MS) * PERF_BUCKET_MS;
  const hit = buckets.find((b) => b.at === slot);
  if (hit) return hit;
  const fresh: SpawnBucket = { at: slot, spawns: {}, sync_spawns: 0, sync_blocked_ms: 0 };
  buckets.push(fresh);
  buckets.sort((a, b) => a.at - b.at);
  while (buckets.length > PERF_BUCKETS) buckets.shift();
  return fresh;
}

/** `git -C repo merge-base …` → `git merge-base`; `tmux capture-pane …` → `tmux capture-pane`; else the command name. */
export function commandLabel(file: string, args: readonly unknown[] | undefined): string {
  const base = String(file).split('/').pop() ?? String(file);
  const list = (args ?? []).map((a) => String(a));
  if (base === 'git') {
    let i = 0;
    while (i < list.length) {
      if (list[i] === '-C' || list[i] === '-c') { i += 2; continue; }
      if (list[i].startsWith('-')) { i += 1; continue; }
      return `git ${list[i]}`;
    }
    return 'git';
  }
  if (base === 'tmux') {
    const sub = list.find((a, i) => !a.startsWith('-') && (i === 0 || !['-S', '-L', '-t', '-b'].includes(list[i - 1])));
    return sub ? `tmux ${sub}` : 'tmux';
  }
  return base;
}

/** Count one child process. Exported for tests. */
export function recordSpawn(label: string, opts: { sync: boolean; ms?: number }, now = Date.now()): void {
  const b = bucket(now);
  b.spawns[label] = (b.spawns[label] ?? 0) + 1;
  if (opts.sync) {
    b.sync_spawns += 1;
    b.sync_blocked_ms += opts.ms ?? 0;
  }
}

/** A background job finished: remember how long it took. */
export function recordJob(name: string, ms: number, now = Date.now()): void {
  const prev = jobs.get(name);
  jobs.set(name, { last_ms: ms, last_at: now, max_ms: Math.max(prev?.max_ms ?? 0, ms), runs: (prev?.runs ?? 0) + 1 });
}

type ChildProcessModule = typeof import('node:child_process');

/**
 * Wrap child_process so every fork is counted. CommonJS exports are patched
 * and the ESM facade re-synced, so `import { execFileSync }` sites see it too.
 */
function patchChildProcess(): void {
  if (patched) return;
  patched = true;
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process') as ChildProcessModule;
  type AnyFn = (...a: unknown[]) => unknown;
  const wrapSync = <F>(fn: F, label: (args: unknown[]) => string): F => {
    const inner = fn as unknown as AnyFn;
    return (function (this: unknown, ...args: unknown[]) {
      const t0 = Date.now();
      try { return inner.apply(this, args); } finally { recordSpawn(label(args), { sync: true, ms: Date.now() - t0 }); }
    }) as unknown as F;
  };
  const wrapAsync = <F>(fn: F, label: (args: unknown[]) => string): F => {
    const inner = fn as unknown as AnyFn;
    return (function (this: unknown, ...args: unknown[]) {
      recordSpawn(label(args), { sync: false });
      return inner.apply(this, args);
    }) as unknown as F;
  };
  const fileArgs = (args: unknown[]) => commandLabel(String(args[0]), Array.isArray(args[1]) ? args[1] : []);
  const shellArgs = (args: unknown[]) => { const cmd = String(args[0]).trim().split(/\s+/); return commandLabel(cmd[0] ?? '', cmd.slice(1)); };
  cp.execFileSync = wrapSync(cp.execFileSync, fileArgs);
  cp.spawnSync = wrapSync(cp.spawnSync, fileArgs);
  cp.execSync = wrapSync(cp.execSync, shellArgs);
  cp.execFile = wrapAsync(cp.execFile, fileArgs);
  cp.spawn = wrapAsync(cp.spawn, fileArgs);
  cp.exec = wrapAsync(cp.exec, shellArgs);
  syncBuiltinESMExports();
}

function sum(list: SpawnBucket[]): { spawns: Record<string, number>; sync_spawns: number; sync_blocked_ms: number } {
  const spawns: Record<string, number> = {};
  let syncSpawns = 0;
  let blocked = 0;
  for (const b of list) {
    for (const [k, v] of Object.entries(b.spawns)) spawns[k] = (spawns[k] ?? 0) + v;
    syncSpawns += b.sync_spawns;
    blocked += b.sync_blocked_ms;
  }
  return { spawns, sync_spawns: syncSpawns, sync_blocked_ms: Math.round(blocked) };
}

function loopStats(): PerfSnapshot['loop_ms'] {
  if (!histogram || histogram.count === 0) return null;
  const ms = (n: number) => Math.round(n / 1e6 * 10) / 10;
  const out = { p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), max: ms(histogram.max), mean: ms(histogram.mean) };
  return out;
}

function cpuPercent(now = Date.now()): number | null {
  const usage = process.cpuUsage();
  if (!lastCpu) { lastCpu = { usage, at: now }; return null; }
  const wall = (now - lastCpu.at) * 1000; // µs
  if (wall <= 0) return null;
  const used = (usage.user - lastCpu.usage.user) + (usage.system - lastCpu.usage.system);
  lastCpu = { usage, at: now };
  return Math.round((used / wall) * 1000) / 10;
}

export function perfSnapshot(now = Date.now()): PerfSnapshot {
  const current = bucket(now);
  const window = buckets.filter((b) => b.at > now - PERF_BUCKETS * PERF_BUCKET_MS);
  const jobsOut: PerfSnapshot['jobs'] = {};
  for (const [name, j] of jobs) jobsOut[name] = { last_ms: j.last_ms, last_at: new Date(j.last_at).toISOString(), max_ms: j.max_ms, runs: j.runs };
  return {
    at: new Date(now).toISOString(),
    uptime_s: Math.round(process.uptime()),
    loop_ms: loopStats(),
    cpu_pct: cpuPercent(now),
    rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    last_minute: sum([current]),
    last_15_min: sum(window),
    jobs: jobsOut,
    lag_threshold_ms: LAG_P99_MS,
  };
}

function checkLag(): void {
  const loop = loopStats();
  if (!loop) return;
  if (loop.p99 >= LAG_P99_MS && Date.now() - lastLagAlert > LAG_ALERT_EVERY_MS) {
    lastLagAlert = Date.now();
    const minute = sum([bucket()]);
    logger.warn({ loop, spawns: minute.spawns, sync_blocked_ms: minute.sync_blocked_ms }, 'Event loop lagging');
    emit('perf.lag', 'system', 'daemon', { p99_ms: loop.p99, max_ms: loop.max, sync_blocked_ms: minute.sync_blocked_ms, spawns: minute.spawns }, null);
  }
  histogram?.reset();
  cpuPercent();
}

export function startPerfMonitor(): void {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  }
  patchChildProcess();
  cpuPercent();
  if (!lagTimer) {
    lagTimer = setInterval(checkLag, PERF_BUCKET_MS);
    lagTimer.unref?.();
  }
}

export function stopPerfMonitor(): void {
  if (lagTimer) clearInterval(lagTimer);
  lagTimer = null;
  histogram?.disable();
  histogram = null;
}

export function resetPerfMonitorForTest(): void {
  buckets.length = 0;
  jobs.clear();
  lastCpu = null;
  lastLagAlert = 0;
}
