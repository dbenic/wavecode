import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    projects: { wavepulse: { repo: null, tests: { status_command: ['t', 'status', '--lane', '{lane}'], history_command: ['t', 'history', '--sha', '{sha}'] } } },
  })),
}));
vi.mock('./logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { readLaneReport, SETTLED_GREEN_TTL_MS, SETTLED_RED_TTL_MS, setTestRunExecForTest, setTestRunTtlForTest, settledStaleOkMs } from './test-runs.js';

const SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const SHA2 = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function report(runs: Array<Record<string, unknown>>, errors: unknown[] = []): string {
  return JSON.stringify({ v: 1, errors, runs: runs.map((r, i) => ({ id: `r${i}`, sha: SHA, who: 'wave.runner.wc-lane', kind: 'dev', suite: 'tier1', state: 'pass', ended_at: '2026-10-28T20:00:00.000Z', ...r })) });
}

describe('a settled SHA is not asked of the gateway again', () => {
  let calls: string[][];
  beforeEach(() => {
    calls = [];
    setTestRunTtlForTest(0); // every read is live unless the SHA is settled
  });

  it('quick and full both green: the cached report is served for six hours', async () => {
    const green = report([{ suite: 'tier1' }, { id: 'g', suite: 'full', kind: 'gate' }]);
    setTestRunExecForTest((argv) => { calls.push(argv); return green; });
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(2);
    expect(settledStaleOkMs('wavepulse', 'wc-lane', SHA)).toBeGreaterThanOrEqual(SETTLED_GREEN_TTL_MS);
    const again = await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(2);
    expect(again.runs.map((r) => r.id).sort()).toEqual(['g', 'r0']);
    // the marker expires: the next read is live again
    expect(settledStaleOkMs('wavepulse', 'wc-lane', SHA, Date.now() + SETTLED_GREEN_TTL_MS + 1)).toBeNull();
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(4);
  });

  it('a pending or missing gate keeps the read live; both red settles for two minutes only', async () => {
    let text = report([{ suite: 'tier1' }, { id: 'g', suite: 'full', kind: 'gate', state: 'running', ended_at: null }]);
    setTestRunExecForTest((argv) => { calls.push(argv); return text; });
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(4);
    expect(settledStaleOkMs('wavepulse', 'wc-lane', SHA)).toBeNull();
    text = report([{ suite: 'tier1', state: 'fail' }, { id: 'g', suite: 'full', kind: 'gate', state: 'fail' }]);
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(6);
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(6);
    expect(settledStaleOkMs('wavepulse', 'wc-lane', SHA, Date.now() + SETTLED_RED_TTL_MS + 1)).toBeNull();
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(8);
  });

  it('a host error never settles, and another SHA on the lane is read on its own', async () => {
    setTestRunExecForTest((argv) => { calls.push(argv); return report([{ suite: 'tier1' }, { id: 'g', suite: 'full', kind: 'gate' }], [{ host: 'h', msg: 'reset' }]); });
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(calls).toHaveLength(4);
    setTestRunExecForTest((argv) => { calls.push(argv); return report([{ suite: 'tier1' }, { id: 'g', suite: 'full', kind: 'gate' }]); });
    await readLaneReport('wavepulse', 'wc-lane', SHA);
    expect(settledStaleOkMs('wavepulse', 'wc-lane', SHA)).not.toBeNull();
    expect(settledStaleOkMs('wavepulse', 'wc-lane', SHA2)).toBeNull();
    await readLaneReport('wavepulse', 'wc-lane', SHA2);
    expect(calls.filter((a) => a.includes(SHA2))).toHaveLength(1);
  });
});
