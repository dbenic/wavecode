import { describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ projects: { wavepulse: { repo: null, tests: { full_suites: ['api', 'full-tuned', 'full'] } } } })) }));
vi.mock('./db.js', () => ({ getDb: vi.fn(() => { throw new Error('no db in this test'); }) }));
vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => null) }));
vi.mock('./test-runs.js', async () => {
  const actual = await vi.importActual<typeof import('./test-runs.js')>('./test-runs.js');
  return { ...actual, readLaneTests: vi.fn(async () => []), readRecentRuns: vi.fn(async () => []), testsConfigured: vi.fn(() => false) };
});
vi.mock('./lane-main.js', () => ({ projectRepo: vi.fn(() => null) }));

import {
  CANONICAL_SUITES, SUITE_ALIASES, assertCanonicalSuite, buildGateRecord, canonicalSuite, checkGateStatus, formatReport, gateExitCode, judge, parseRequire,
  parseResultLine, runIdOf, suiteLabelOf, type GateRecord, type JudgeInput,
} from './gate-status.js';
import type { TestRun } from './test-runs.js';

const X = '7e27b7d2d0252ba64db3470a30342a6312562565';
const DONOR = '3857882f94b006d6da00ecc2b3f41cd9dc66f78d';
const TREE = 'de6d9d26585a069add33daf2db2b47ae88669cba';
const OTHER_TREE = '1111111111111111111111111111111111111111';

function run(over: Partial<TestRun>): TestRun {
  return {
    id: over.id ?? '20261026-150000-000000000-g1', sha: over.sha ?? X, lane: null, who: 'wave.countix-dev.x', kind: over.kind ?? 'dev', suite: over.suite ?? 'quick',
    state: over.state ?? 'pass', queue_pos: null, host: 'countix-testing', queued_at: '2026-10-26T14:00:00+01:00', started_at: over.started_at ?? '2026-10-26T14:00:00+01:00',
    ended_at: over.ended_at === undefined ? '2026-10-26T14:10:00+01:00' : over.ended_at, wait_s: 0, run_s: 600, failing_step: null, summary: null, log: null, superseded_by: null,
  };
}

function input(over: Partial<JudgeInput>): JudgeInput {
  return { sha: X, tree_sha: TREE, project: 'wavepulse', require: ['quick', 'api'], direct: [], recent: [], records: [], legacy: [], trees: new Map([[X, TREE]]), fullSuites: ['api', 'full'], now: new Date('2026-10-26T15:00:00Z'), ...over };
}

function record(over: Partial<GateRecord>): GateRecord {
  return {
    schema_version: 1, sha: X, tree_sha: TREE, suite: 'quick', label: 'tier1', state: 'GREEN', exit_code: 0, run_id: '20261026-144952-7e27b7d2d-g1660090', runner: 'countix-remote-test',
    started_at: '2026-10-26T13:49:52.000Z', finished_at: '2026-10-26T13:59:00.000Z', duration_s: 548, steps: { result_line: null, tail: [] }, reused_from: null, wavecode_build: 'test', ...over,
  };
}

describe('gate-status: the registry', () => {
  it('has exactly the canonical suites and a frozen alias map; tier1 is quick, gate kind is full', () => {
    expect([...CANONICAL_SUITES]).toEqual(['quick', 'api', 'full']);
    expect(Object.isFrozen(SUITE_ALIASES)).toBe(true);
    expect(canonicalSuite('tier1')).toBe('quick');
    expect(canonicalSuite('TIER1 ')).toBe('quick');
    expect(canonicalSuite('full-tuned')).toBe('full');
    expect(canonicalSuite(null, 'gate')).toBe('full');
    expect(canonicalSuite('smoke')).toBeNull();
  });

  it('a writer naming a non-canonical suite fails', () => {
    expect(() => assertCanonicalSuite('tier1')).toThrow(/not a canonical suite: tier1/);
    expect(assertCanonicalSuite('quick')).toBe('quick');
  });

  it('require accepts the canonical names and gate, defaults to quick,api, rejects the rest', () => {
    expect(parseRequire('quick, API')).toEqual(['quick', 'api']);
    expect(parseRequire('')).toEqual(['quick', 'api']);
    expect(parseRequire('quick,gate,quick')).toEqual(['quick', 'gate']);
    expect(parseRequire('quick,tier1')).toEqual({ error: 'unknown suite tier1 (use quick, api, full, gate)' });
  });
});

describe('gate-status: the judge', () => {
  it('the 26 Oct case: a tier1 PASS on X reads as GREEN quick for X', () => {
    const r = judge(input({ require: ['quick'], direct: [run({ suite: 'tier1' })] }));
    expect(r.suites.quick).toMatchObject({ state: 'GREEN', source: 'gateway', run_id: '20261026-150000-000000000-g1' });
    expect(r.verdict).toBe('GREEN');
    expect(r.exit_code).toBe(0);
  });

  it('a result the gateway filed under a donor counts only when the trees are identical', () => {
    const reused = run({ id: `20261026-144952-${X.slice(0, 9)}-g1660090`, sha: DONOR, suite: 'quick' });
    const same = judge(input({ require: ['quick'], recent: [reused], trees: new Map([[X, TREE], [DONOR, TREE]]) }));
    expect(same.suites.quick).toMatchObject({ state: 'GREEN', source: 'gateway-reuse', reused_from: { sha: DONOR, tree_sha: TREE } });
    expect(same.exit_code).toBe(0);
    const different = judge(input({ require: ['quick'], recent: [reused], trees: new Map([[X, TREE], [DONOR, OTHER_TREE]]) }));
    expect(different.suites.quick.state).toBe('MISSING');
    expect(different.exit_code).toBe(2);
    expect(different.found[0]).toMatchObject({ counts: false, tree_match: false, why: `label quick normalized to quick, tree mismatch with donor ${DONOR.slice(0, 8)} (target tree ${TREE.slice(0, 8)}, donor tree 11111111)` });
    expect(different.suites.quick.note).toMatch(/^nothing counts for quick: gateway-reuse 20261026-144952-7e27b7d2d-g1660090 GREEN — label quick normalized to quick, tree mismatch/);
    const unknown = judge(input({ require: ['quick'], recent: [reused], trees: new Map([[X, TREE]]) }));
    expect(unknown.suites.quick.state).toBe('MISSING');
    expect(unknown.found[0].why).toMatch(/no tree for donor 3857882f, cannot confirm an identical tree/);
  });

  it("a WaveCode record with a donor counts on the donor's identical tree and not otherwise", () => {
    const rec = record({ reused_from: { sha: DONOR, tree_sha: TREE } });
    expect(judge(input({ require: ['quick'], records: [rec] })).suites.quick).toMatchObject({ state: 'GREEN', source: 'wavecode', reused_from: { sha: DONOR, tree_sha: TREE } });
    const bad = judge(input({ require: ['quick'], records: [record({ reused_from: { sha: DONOR, tree_sha: OTHER_TREE } })] }));
    expect(bad.suites.quick.state).toBe('MISSING');
    expect(bad.found[0].why).toMatch(/tree mismatch with donor 3857882f/);
  });

  it('RUNNING never counts as green; the latest finished run wins; a later RED beats an earlier GREEN', () => {
    const running = judge(input({ require: ['quick'], direct: [run({ id: 'r1', state: 'running', ended_at: null })] }));
    expect(running.suites.quick.state).toBe('RUNNING');
    expect(running.exit_code).toBe(4);
    const greenThenRunning = judge(input({ require: ['quick'], direct: [run({ id: 'g', ended_at: '2026-10-26T14:10:00+01:00' }), run({ id: 'r', state: 'running', ended_at: null, started_at: '2026-10-26T14:30:00+01:00' })] }));
    expect(greenThenRunning.suites.quick).toMatchObject({ state: 'GREEN', run_id: 'g', note: expect.stringMatching(/1 still running/) });
    const redLater = judge(input({ require: ['quick'], direct: [run({ id: 'g', ended_at: '2026-10-26T14:10:00+01:00' }), run({ id: 'f', state: 'fail', ended_at: '2026-10-26T14:40:00+01:00' })] }));
    expect(redLater.suites.quick).toMatchObject({ state: 'RED', run_id: 'f' });
    expect(redLater.exit_code).toBe(3);
    const greenLater = judge(input({ require: ['quick'], direct: [run({ id: 'f', state: 'fail', ended_at: '2026-10-26T14:10:00+01:00' }), run({ id: 'g', ended_at: '2026-10-26T14:40:00+01:00' })] }));
    expect(greenLater.suites.quick).toMatchObject({ state: 'GREEN', run_id: 'g' });
  });

  it('gate means any of the project full suites; api is api; a kind=gate run is full', () => {
    const r = judge(input({ require: ['quick', 'gate', 'api', 'full'], direct: [run({ suite: 'tier1' }), run({ id: 'a', suite: 'api' })] }));
    expect(r.suites.gate.state).toBe('GREEN');
    expect(r.suites.api.state).toBe('GREEN');
    expect(r.suites.full.state).toBe('MISSING');
    expect(r.verdict).toBe('MISSING');
    const g = judge(input({ require: ['full'], direct: [run({ id: 'k', suite: 'gate', kind: 'gate' })] }));
    expect(g.suites.full.state).toBe('GREEN');
  });

  it('a tool ERROR is reported with its reason and never counts as green; RED outranks RUNNING outranks ERROR outranks MISSING', () => {
    const err = judge(input({ require: ['quick'], records: [record({ state: 'ERROR', exit_code: 5, steps: { result_line: null, tail: ['countix-remote-test: remote exit 5 on host=countix-testing'] } })] }));
    expect(err.suites.quick.state).toBe('ERROR');
    expect(err.exit_code).toBe(1);
    expect(err.found[0].why).toBe('tool error (exit 5): countix-remote-test: remote exit 5 on host=countix-testing');
    const mixed = judge(input({ require: ['quick', 'api'], direct: [run({ suite: 'quick', state: 'fail' }), run({ id: 'a', suite: 'api', state: 'running', ended_at: null })] }));
    expect(mixed.verdict).toBe('RED');
    expect(gateExitCode('RUNNING')).toBe(4);
  });

  it('legacy pipeline.gate words are read as the full gate, for notes and rows written before the checker', () => {
    const r = judge(input({ require: ['gate'], legacy: [{ gate: 'GREEN', exit_code: 0, created_at: '2026-10-26 12:00:00' }] }));
    expect(r.suites.gate).toMatchObject({ state: 'GREEN', source: 'wavecode-legacy' });
  });

  it('the JSON report has a stable shape', () => {
    const r = judge(input({ require: ['quick'], direct: [run({})] }));
    expect(Object.keys(r)).toEqual(['schema_version', 'sha', 'tree_sha', 'project', 'require', 'suites', 'verdict', 'exit_code', 'found', 'errors', 'checked_at', 'wavecode_build']);
    expect(Object.keys(r.suites.quick)).toEqual(['state', 'run_id', 'finished_at', 'source', 'reused_from', 'note']);
    expect(Object.keys(r.found[0])).toEqual(['source', 'run_id', 'suite', 'label', 'state', 'started_at', 'finished_at', 'result_sha', 'reused_from', 'tree_match', 'counts', 'why']);
    expect(r.checked_at).toBe('2026-10-26T15:00:00.000Z');
    expect(formatReport(r)).toMatch(/^GREEN 7e27b7d2 \(tree de6d9d26\)\n  quick GREEN   GREEN from gateway 20261026-150000-000000000-g1$/);
  });
});

describe('gate-status: the checker and the writer', () => {
  it('rejects an abbreviated SHA with exit 1 and says so', async () => {
    const r = await checkGateStatus('wavepulse', '7e27b7d2', ['quick']);
    expect(r.verdict).toBe('ERROR');
    expect(r.exit_code).toBe(1);
    expect(r.errors).toEqual(['sha must be the full 40-character SHA, got 8 characters']);
  });

  it('reads the RESULT line, the run id and the donor from the tool output; no RESULT and a non-zero exit is an ERROR', async () => {
    const stdout = [
      'countix-remote-test: pushed in 1s; running suite tier1 on host=countix-testing',
      'dispatch 20261026-144952-7e27b7d2d-g1660090',
      `=== RESULT GREEN sha=${DONOR.slice(0, 9)} suite=tier1 who=wave.countix-dev.x exit=0 host=runner-c ===`,
    ].join('\n');
    expect(parseResultLine(stdout)).toMatchObject({ word: 'GREEN', sha: DONOR.slice(0, 9), suite: 'tier1' });
    expect(runIdOf(stdout)).toBe('20261026-144952-7e27b7d2d-g1660090');
    expect(suiteLabelOf(['countix-remote-test', '--suite', 'api'])).toBe('api');
    expect(suiteLabelOf(['countix-remote-test', 'tier1'])).toBe('tier1');
    expect(suiteLabelOf(['countix-remote-test'])).toBe('tier1');
    const rec = await buildGateRecord({ project: 'wavepulse', sha: X, argv: ['countix-remote-test', '--suite', 'tier1'], stdout, exit_code: 143, started_at: new Date('2026-10-26T13:49:52Z'), finished_at: new Date('2026-10-26T13:59:00Z') });
    expect(rec).toMatchObject({ schema_version: 1, sha: X, suite: 'quick', label: 'tier1', state: 'GREEN', exit_code: 143, run_id: '20261026-144952-7e27b7d2d-g1660090', duration_s: 548, reused_from: { sha: DONOR.slice(0, 9), tree_sha: null } });
    const err = await buildGateRecord({ project: 'wavepulse', sha: X, argv: ['countix-remote-test', '--suite', 'api'], stdout: 'countix-remote-test: remote exit 5 on host=countix-testing (4s total)', exit_code: 5, started_at: new Date(), finished_at: new Date() });
    expect(err).toMatchObject({ suite: 'api', state: 'ERROR', run_id: null });
    const queued = await buildGateRecord({ project: 'wavepulse', sha: X, argv: ['countix-remote-test'], stdout: 'QUEUED', exit_code: 7, started_at: new Date(), finished_at: new Date() });
    expect(queued.state).toBe('RUNNING');
  });
});
