import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FULL_SUITES, DEFAULT_QUICK_SUITES, fullRunPhrase, HOST_UNREACHABLE, isFullRun, isQuickRun,
  liveGateForRuns, parseTestReport, shaChecks, suiteNames, testChipLabel,
} from './test-runs.js';

const SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const NAMES = { quick: DEFAULT_QUICK_SUITES, full: DEFAULT_FULL_SUITES };

function run(over: Record<string, unknown>) {
  return {
    id: 'r', sha: SHA, who: 'wave.runner.wc-lane-a', kind: 'dev', suite: 'quick',
    state: 'pass', queue_pos: null, host: 'runner.example', ...over,
  };
}

describe('parseTestReport', () => {
  it('maps tier1 to quick, derives the lane from who, and keeps a host error', () => {
    const text = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/test-runs/sample.json'), 'utf8');
    const report = parseTestReport(text);
    expect(report).not.toBeNull();
    expect(report!.errors).toEqual([{ host: 'runner.example', msg: 'connection reset' }]);
    expect(report!.runs[0]).toMatchObject({ suite: 'quick', lane: 'wc-lane-a', state: 'queued', queue_pos: 2, summary: null });
    expect(HOST_UNREACHABLE).toBe('test host unreachable');
  });

  it('rejects a different schema version and ignores unknown fields', () => {
    expect(parseTestReport('{"v":2,"runs":[]}')).toBeNull();
    const report = parseTestReport(JSON.stringify({
      v: 1,
      runs: [{ id: 'g', sha: SHA.slice(0, 8), who: 'unknown', kind: 'gate', suite: 'full', state: 'pass', mystery: 1, ended_at: '2026-10-12T12:00:00.000+02:00' }],
    }));
    expect(report!.runs[0]).toMatchObject({ lane: null, suite: 'full-tuned', kind: 'gate', sha: SHA.slice(0, 8) });
  });

  it('treats timeout as fail, synthesizes a queued id, and accepts cancelled', () => {
    const report = parseTestReport(JSON.stringify({
      v: 1,
      runs: [
        { sha: SHA, suite: 'quick', state: 'timeout' },
        { id: null, sha: SHA, suite: 'tier1', state: 'queued', queue_pos: 1 },
        { id: 'c', sha: SHA, suite: 'quick', state: 'cancelled' },
        { id: 's', sha: SHA, suite: 'full-tuned', state: 'superseded', superseded_by: null },
        { id: 'd', sha: SHA, suite: 'quick', state: 'duplicate' },
      ],
    }));
    expect(report!.runs.map((r) => r.state)).toEqual(['fail', 'queued', 'cancelled', 'superseded', 'duplicate']);
    expect(report!.runs[0].failing_step).toBe('timeout');
    expect(report!.runs[1].id).toMatch(/^anon-queued-/);
  });
});

describe('shaChecks', () => {
  it('matches a gate by sha prefix and lets a later fail beat an earlier pass', () => {
    const runs = parseTestReport(JSON.stringify({
      v: 1,
      runs: [
        run({ id: 'old', kind: 'gate', who: 'unknown', suite: 'full-tuned', state: 'pass', ended_at: '2026-10-12T10:00:00.000+02:00', sha: SHA }),
        run({ id: 'new', kind: 'gate', who: 'unknown', suite: 'full', state: 'fail', failing_step: 'api', ended_at: '2026-10-12T12:00:00.000+02:00', sha: SHA.slice(0, 8), host: 'other.example' }),
      ],
    }))!.runs;
    expect(runs[1].lane).toBeNull();
    expect(isFullRun(runs[1], NAMES.full)).toBe(true);
    const checks = shaChecks(runs, SHA, NAMES);
    expect(checks.full).toBe('red');
    expect(checks.fullRun?.failing_step).toBe('api');
    expect(checks.fullRun?.host).toBe('other.example');
  });

  it('keeps Stage waiting while a full run is still in flight, even after an older pass', () => {
    const runs = parseTestReport(JSON.stringify({
      v: 1,
      runs: [
        run({ id: 'done', kind: 'gate', suite: 'full-tuned', state: 'pass', ended_at: '2026-10-12T10:00:00.000+02:00' }),
        run({ id: 'now', kind: 'gate', suite: 'full-tuned', state: 'running', host: 'runner.example', run_s: 360, ended_at: null }),
      ],
    }))!.runs;
    expect(shaChecks(runs, SHA, NAMES).full).toBe('pending');
    expect(liveGateForRuns(runs, SHA)).toBe('pending');
    expect(fullRunPhrase(shaChecks(runs, SHA, NAMES).fullRun)).toBe('running 6m on runner.example');
  });

  it('a green tier1 quick check is not a full gate', () => {
    const runs = parseTestReport(JSON.stringify({
      v: 1,
      runs: [run({ suite: 'tier1', kind: 'dev', state: 'pass', ended_at: '2026-10-12T12:00:00.000+02:00' })],
    }))!.runs;
    expect(isQuickRun(runs[0], NAMES.quick)).toBe(true);
    expect(isFullRun(runs[0], NAMES.full)).toBe(false);
    const checks = shaChecks(runs, SHA, NAMES);
    expect(checks.quick).toBe('green');
    expect(checks.full).toBe('missing');
  });

  it('uses configured suite names', () => {
    const names = { quick: ['smoke'], full: ['nightly'] };
    const runs = parseTestReport(JSON.stringify({
      v: 1,
      runs: [run({ suite: 'smoke', state: 'pass', ended_at: '2026-10-12T12:00:00.000+02:00' })],
    }))!.runs;
    expect(shaChecks(runs, SHA, names).quick).toBe('green');
    expect(shaChecks(runs, SHA, NAMES).quick).toBe('missing');
    expect(suiteNames(null)).toEqual({ quick: DEFAULT_QUICK_SUITES, full: DEFAULT_FULL_SUITES });
  });

  it('labels the chip', () => {
    const queued = parseTestReport(JSON.stringify({ v: 1, runs: [run({ state: 'queued', queue_pos: 2, wait_s: 120 })] }))!.runs[0];
    expect(testChipLabel(queued)).toBe('queued (#2, waiting 2m)');
  });
});
