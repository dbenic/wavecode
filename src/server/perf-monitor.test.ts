import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe('perf-monitor', () => {
  beforeEach(async () => {
    const m = await import('./perf-monitor.js');
    m.resetPerfMonitorForTest();
  });
  afterEach(async () => {
    const m = await import('./perf-monitor.js');
    m.stopPerfMonitor();
  });

  it('labels a fork by its command: git subcommand after -C, tmux subcommand, else the binary', async () => {
    const { commandLabel } = await import('./perf-monitor.js');
    expect(commandLabel('git', ['-C', '/repo', 'merge-base', '--is-ancestor', 'a', 'b'])).toBe('git merge-base');
    expect(commandLabel('/usr/bin/git', ['-c', 'core.x=1', '-C', '/repo', 'rev-parse', 'HEAD'])).toBe('git rev-parse');
    expect(commandLabel('tmux', ['-L', 'wc', 'capture-pane', '-t', 'wc-a', '-p'])).toBe('tmux capture-pane');
    expect(commandLabel('tmux', ['send-keys', '-t', 'wc-a', 'x'])).toBe('tmux send-keys');
    expect(commandLabel('/usr/bin/npm', ['ci'])).toBe('npm');
  });

  it('counts spawns per minute, blocking time, and job durations; every fork through child_process is seen', async () => {
    const m = await import('./perf-monitor.js');
    const t0 = 1_700_000_000_000;
    m.recordSpawn('git merge-base', { sync: true, ms: 12 }, t0);
    m.recordSpawn('git merge-base', { sync: true, ms: 8 }, t0 + 1000);
    m.recordSpawn('tmux capture-pane', { sync: false }, t0 + 2000);
    m.recordSpawn('git fetch', { sync: true, ms: 300 }, t0 - 5 * 60_000); // an earlier minute
    m.recordJob('deploy_reconcile', 2500, t0);
    m.recordJob('deploy_reconcile', 900, t0 + 90_000);
    const snap = m.perfSnapshot(t0 + 2500);
    expect(snap.last_minute.spawns).toEqual({ 'git merge-base': 2, 'tmux capture-pane': 1 });
    expect(snap.last_minute.sync_spawns).toBe(2);
    expect(snap.last_minute.sync_blocked_ms).toBe(20);
    expect(snap.last_15_min.spawns['git fetch']).toBe(1);
    expect(snap.last_15_min.sync_blocked_ms).toBe(320);
    expect(snap.jobs.deploy_reconcile).toMatchObject({ last_ms: 900, max_ms: 2500, runs: 2 });
    expect(snap.lag_threshold_ms).toBe(m.LAG_P99_MS);

    // the real patch: a fork through child_process is counted without the caller changing
    m.startPerfMonitor();
    const cp = await import('node:child_process');
    cp.execFile('git', ['--version'], () => undefined);
    const after = m.perfSnapshot();
    expect(after.last_minute.spawns['git --version'] ?? after.last_minute.spawns['git']).toBeGreaterThanOrEqual(1);
    expect(after.loop_ms === null || after.loop_ms.p50 >= 0).toBe(true);
  });
});
