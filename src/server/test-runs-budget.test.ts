import { describe, expect, it, vi } from 'vitest';

const projects: Record<string, Record<string, unknown>> = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ projects, releases: {}, peers: {}, paths: {}, artifacts: { storage: '' }, notifications: {} })),
}));

import { pollTargetsForTest, readCachedLaneTests, readLaneTests, readLaneTestsSparingly, runnerLoadForTest, setTestRunExecForTest, setTestRunTtlForTest, stopTestRunPoller, watchTestRuns } from './test-runs.js';

describe('runner command budget', () => {
  it('shares one command between concurrent reads, serves stale reports on request, and runs at most three at once', async () => {
    projects.budget = { repo: '/nowhere', tests: { history_command: ['hist', '--sha', '{sha}'] } };
    const calls: string[][] = [];
    const resolvers: Array<(v: string) => void> = [];
    const report = (sha: string) => JSON.stringify({ v: 1, runs: [{ id: `r-${sha}`, sha, who: 'ales', kind: 'dev', suite: 'api', state: 'pass', queued_at: '2026-10-25T10:00:00Z', ended_at: '2026-10-25T10:10:00Z' }] });
    setTestRunExecForTest((argv) => { calls.push(argv); return new Promise<string>((resolve) => resolvers.push(resolve)); });
    setTestRunTtlForTest(50);
    try {
      const shas = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
      const reads = [...shas, shas[0], shas[0]].map((sha) => readLaneTests('budget', 'wc-x', sha));
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(3); // six reads, four distinct SHAs, three slots
      expect(runnerLoadForTest()).toEqual({ active: 3, waiting: 1, pending: 4 });
      resolvers.splice(0).forEach((resolve, i) => resolve(report(shas[i])));
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(4); // the fourth took the freed slot
      resolvers.splice(0).forEach((resolve) => resolve(report(shas[3])));
      const results = await Promise.all(reads);
      expect(results.map((r) => r[0]?.id)).toEqual(['r-' + shas[0], 'r-' + shas[1], 'r-' + shas[2], 'r-' + shas[3], 'r-' + shas[0], 'r-' + shas[0]]);
      expect(runnerLoadForTest()).toEqual({ active: 0, waiting: 0, pending: 0 });

      await new Promise((r) => setTimeout(r, 60)); // past the TTL
      expect(readCachedLaneTests('budget', 'wc-x', shas[0])?.[0]?.id).toBe('r-' + shas[0]);
      const stale = readLaneTests('budget', 'wc-x', shas[0], { staleOkMs: 60_000 });
      expect(calls).toHaveLength(4); // stale is fine: no command
      expect((await stale)[0]?.id).toBe('r-' + shas[0]);

      const now = Date.now();
      const iso = (ms: number) => new Date(now - ms).toISOString().replace('T', ' ').slice(0, 19);
      const freeze = (sha: string, status: string, ageMs: number) => ({ project: 'budget', lane: 'wc-x', sha, status, created_at: iso(ageMs) });
      // closed or behind main: cache or nothing, no command
      expect(await readLaneTestsSparingly(freeze('e'.repeat(40), 'merged', 1000), { settled: false, pending: false })).toBeNull();
      expect(await readLaneTestsSparingly(freeze('e'.repeat(40), 'behind-main', 1000), { settled: false, pending: false })).toBeNull();
      expect(calls).toHaveLength(4);
      // old open freeze with settled words: cache or nothing
      expect(await readLaneTestsSparingly(freeze('e'.repeat(40), 'open', 4 * 24 * 3600_000), { settled: true, pending: false })).toBeNull();
      expect(calls).toHaveLength(4);
      // old open freeze with unsettled words: read, then served stale for hours
      const p1 = readLaneTestsSparingly(freeze('e'.repeat(40), 'open', 4 * 24 * 3600_000), { settled: false, pending: false });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(5);
      resolvers.splice(0).forEach((resolve) => resolve(report('e'.repeat(40))));
      expect((await p1)?.[0]?.id).toBe('r-' + 'e'.repeat(40));
      await new Promise((r) => setTimeout(r, 60));
      expect(await readLaneTestsSparingly(freeze('e'.repeat(40), 'open', 4 * 24 * 3600_000), { settled: false, pending: false })).toHaveLength(1);
      expect(calls).toHaveLength(5);
      // a fresh open freeze is read live past the TTL
      const p2 = readLaneTestsSparingly(freeze('e'.repeat(40), 'open', 1000), { settled: true, pending: false });
      await new Promise((r) => setTimeout(r, 5));
      expect(calls).toHaveLength(6);
      resolvers.splice(0).forEach((resolve) => resolve(report('e'.repeat(40))));
      await p2;
    } finally {
      setTestRunExecForTest(null);
      setTestRunTtlForTest(20_000);
      delete projects.budget;
    }
  });
});

describe('watchTestRuns', () => {
  it('polls only the lanes whose own run is in flight, never the whole board', () => {
    const t = (lane: string, sha: string) => ({ project: 'budget', lane, sha });
    const run = (sha: string, state: string, lane = 'wc-x') => ({ id: `r-${sha}-${state}`, sha, lane, who: 'ales', kind: 'dev', suite: 'api', state, queued_at: '2026-10-26T08:00:00Z' }) as unknown as import('./test-runs.js').TestRun;
    const targets = [t('wc-a', 'a'.repeat(40)), t('wc-b', 'b'.repeat(40)), t('wc-c', 'c'.repeat(40))];
    try {
      watchTestRuns(targets, [run('b'.repeat(9), 'running', 'wc-b'), run('a'.repeat(40), 'pass', 'wc-a')]);
      expect(pollTargetsForTest().map((x) => x.lane)).toEqual(['wc-b']);
      watchTestRuns(targets, [run('a'.repeat(40), 'pass'), run('c'.repeat(40), 'fail')]);
      expect(pollTargetsForTest()).toEqual([]);
    } finally {
      stopTestRunPoller();
    }
  });
});
