import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BEFORE_FREEZE_TIP, fullFailFlag, laneStatusLine, needsGreenFull, needsGreenQuick, onStagingQuickLine,
  promoteBlockReason, type LaneStatusInput,
} from './lane-status.js';

const SHA = '1e1a5b9caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD = 'c0ffee00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function line(over: Partial<LaneStatusInput> = {}): string {
  const base: LaneStatusInput = {
    sha: HEAD,
    author: 'ales-codex2',
    reviewer: 'reviewer',
    freeze: null,
    gate: { state: 'unconfigured' },
    behindMain: 0,
  };
  return laneStatusLine({ ...base, ...over });
}

describe('laneStatusLine', () => {
  it('names the author freeze when the lane has commits and no freeze', () => {
    expect(line()).toBe(`needs author freeze on ${HEAD.slice(0, 8)} — @ales-codex2`);
  });

  it('joins a protected path, an overlap, and the missing freeze', () => {
    expect(line({
      protectedPath: 'src/version.ts',
      overlap: { lane: 'wc-other', files: 4 },
    })).toBe(`touches src/version.ts — dev lanes must not · overlaps lane wc-other in 4 files · needs author freeze on ${HEAD.slice(0, 8)} — @ales-codex2`);
  });

  it('is only the behind-main line when the lane does not contain main', () => {
    expect(line({ behindMain: 6, protectedPath: 'src/version.ts' })).toBe('behind main by 6 — merge latest main');
  });

  it('says the reviewer is holding when GREEN landed on an evidence-only NEEDS FIXES', () => {
    expect(line({
      sha: SHA,
      reviewer: 'ales-claude1',
      freeze: { sha: SHA, verdict: 'needs-fixes', issues: 0, gate: 'GREEN' },
      full: 'green',
      quick: 'green',
      gate: { state: 'green' },
    })).toBe('reviewer holding for gate — GREEN landed, pinged @ales-claude1');
  });

  it('asks for a PASS when the verdict has real findings', () => {
    expect(line({
      freeze: { sha: SHA, verdict: 'needs-fixes', issues: 2, gate: null },
      gate: { state: 'not_run' },
      quick: 'missing',
      full: 'missing',
    })).toBe(`needs review PASS on ${SHA.slice(0, 8)} — @reviewer`);
  });

  it('tells Stage the quick check is running, or still needed', () => {
    const freeze = { sha: SHA, verdict: 'pass' as const, issues: 0, gate: null };
    expect(line({ freeze, quick: 'pending', full: 'missing', gate: { state: 'running' } })).toBe('quick check running');
    expect(line({ freeze, quick: 'missing', full: 'missing', gate: { state: 'not_run' } })).toBe(needsGreenQuick(SHA.slice(0, 8)));
    expect(line({ freeze, quick: 'red', full: 'red', gate: { state: 'red', failingStep: 'lint' } })).toBe(needsGreenQuick(SHA.slice(0, 8)));
  });

  it('is ready to stage on a green quick check, and names the full run once that SHA is on staging', () => {
    const freeze = { sha: SHA, verdict: 'pass' as const, issues: 0, gate: null };
    expect(line({ freeze, quick: 'green', full: 'missing', gate: { state: 'not_run' } })).toBe('ready — press STAGE');
    expect(line({
      freeze, quick: 'green', full: 'pending', fullRunLabel: 'queued #2', onStaging: true, gate: { state: 'queued' },
    })).toBe(onStagingQuickLine('queued #2'));
    expect(line({
      freeze, quick: 'green', full: 'pending', fullRunLabel: 'running 6m on runner.example', onStaging: true, gate: { state: 'running' },
    })).toBe('On staging (quick check) · Full run: running 6m on runner.example');
    expect(line({
      freeze, quick: 'green', full: 'red', fullRunLabel: 'FAIL: lint', onStaging: true, gate: { state: 'red', failingStep: 'lint' },
    })).toBe('On staging (quick check) · Full run: FAIL: lint');
    expect(fullFailFlag('lint')).toBe('Full run FAILED after staging: lint. Fix before asking for prod');
    expect(promoteBlockReason(SHA.slice(0, 8))).toBe(`full run not green on ${SHA.slice(0, 8)}`);
    expect(needsGreenFull(SHA.slice(0, 8))).toBe(`needs green full gate on ${SHA.slice(0, 8)}`);
  });

  it('says Ready for prod once the full gate is green on staging', () => {
    expect(line({
      freeze: { sha: SHA, verdict: 'pass', issues: 0, gate: 'GREEN' },
      quick: 'green', full: 'green', onStaging: true, gate: { state: 'green' },
    })).toBe('on staging — mark Ready for prod');
  });

  it('keeps the before-freeze tip wording', () => {
    expect(DEFAULT_BEFORE_FREEZE_TIP).toBe('Run the quick check during development, and run the full suite only after the lane is on staging.');
  });
});
