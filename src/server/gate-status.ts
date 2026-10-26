/**
 * One checker for "is SHA X green for suite Y" (Denis, 26 Oct 2026).
 *
 * On 26 Oct 2026 two readers of the same gateway drifted apart: the merge queue
 * recorded its merge gate as "tier1 PASS", staging's green-check accepted only
 * "GREEN quick" or "GREEN full", and a result the gateway reused from an
 * identical tree was filed under the donor SHA (3857882f) instead of the SHA
 * under test (7e27b7d2). Staging refused a green SHA. This module is the one
 * place that answers the question, for the merge queue, the Reviews page, the
 * deploy scripts (through `wavecode gate-status`) and agents.
 *
 * Sources, all read-only here:
 *   - the gateway's history for the exact SHA (`tests.history_command`);
 *   - the gateway's recent history, for results it filed under a donor SHA
 *     (the run id carries the requesting SHA: `20261026-144952-7e27b7d2d-g…`,
 *     row sha = donor). Such a result counts only when the donor's tree equals
 *     the target's tree;
 *   - WaveCode's own records of the gates it dispatched (`gate.result` events,
 *     written by the merge queue and the lane pipeline with the RESULT line,
 *     exit code, run id, trees and the donor when the gateway reused a run);
 *   - the legacy `pipeline.gate` words, read for backward compatibility.
 *
 * Writers use canonical suite names only (`assertCanonicalSuite`); readers
 * normalize every label through the frozen alias map. tier1 is the quick suite:
 * `countix-remote-test` defaults to tier1 as "the quick check" and the gateway
 * files tier1 runs with `suite: quick` (`src/server/test-runs.ts` has stored
 * tier1 as quick since 12 Oct 2026).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { getConfig } from './config.js';
import { getDb } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { projectRepo } from './lane-main.js';
import { readLaneTests, readRecentRuns, testsConfigured, type TestRun } from './test-runs.js';

const execFileAsync = promisify(execFile);

// --- registry ------------------------------------------------------------------

export const CANONICAL_SUITES = ['quick', 'api', 'full'] as const;
export type CanonicalSuite = (typeof CANONICAL_SUITES)[number];

/** Frozen: a legacy label maps to exactly one canonical suite. `gate` is the gateway's kind for a full run. */
export const SUITE_ALIASES: Readonly<Record<string, CanonicalSuite>> = Object.freeze({
  quick: 'quick',
  tier1: 'quick',
  api: 'api',
  full: 'full',
  'full-tuned': 'full',
  gate: 'full',
});

/** `require` accepts the canonical suites and `gate`: any of the project's full suites (api or full) green. */
export const REQUIRABLE = ['quick', 'api', 'full', 'gate'] as const;
export type Requirable = (typeof REQUIRABLE)[number];

export function canonicalSuite(label: string | null | undefined, kind?: 'dev' | 'gate' | null): CanonicalSuite | null {
  const raw = (label ?? '').trim().toLowerCase();
  if (raw && SUITE_ALIASES[raw]) return SUITE_ALIASES[raw];
  if (kind === 'gate') return 'full';
  return null;
}

export function isCanonicalSuite(name: string): name is CanonicalSuite {
  return (CANONICAL_SUITES as readonly string[]).includes(name);
}

/** Writers call this: a non-canonical name is a bug, not a label to store. */
export function assertCanonicalSuite(name: string): CanonicalSuite {
  if (!isCanonicalSuite(name)) throw new Error(`not a canonical suite: ${name} (use ${CANONICAL_SUITES.join(', ')})`);
  return name;
}

export function isRequirable(name: string): name is Requirable {
  return (REQUIRABLE as readonly string[]).includes(name);
}

// --- types ---------------------------------------------------------------------

export type GateState = 'GREEN' | 'RED' | 'ERROR' | 'RUNNING' | 'MISSING';
export type RunState = Exclude<GateState, 'MISSING'>;

export interface ReusedFrom {
  sha: string;
  tree_sha: string | null;
}

/** One result found for the SHA, counting or not, with the reason when it does not. */
export interface GateEvidence {
  source: 'gateway' | 'gateway-reuse' | 'wavecode' | 'wavecode-legacy';
  run_id: string | null;
  /** Canonical suite, null when the label is unknown (then it never counts). */
  suite: CanonicalSuite | null;
  /** The label as the source wrote it. */
  label: string | null;
  state: RunState;
  started_at: string | null;
  finished_at: string | null;
  /** The SHA the result is filed under; differs from the target on a reused run. */
  result_sha: string | null;
  reused_from: ReusedFrom | null;
  /** Target tree equals the donor tree; null when not a reuse or a tree is unknown. */
  tree_match: boolean | null;
  counts: boolean;
  why: string | null;
}

export interface SuiteStatus {
  state: GateState;
  run_id: string | null;
  finished_at: string | null;
  source: GateEvidence['source'] | null;
  reused_from: ReusedFrom | null;
  /** How the state was decided, or why nothing counted. */
  note: string;
}

export interface GateStatusReport {
  schema_version: 1;
  sha: string;
  tree_sha: string | null;
  project: string | null;
  require: Requirable[];
  suites: Record<string, SuiteStatus>;
  verdict: GateState;
  /** 0 all required suites GREEN, 2 missing, 3 red, 4 running, 1 error (bad input, tool error, unknown trees). */
  exit_code: 0 | 1 | 2 | 3 | 4;
  found: GateEvidence[];
  errors: string[];
  checked_at: string;
  wavecode_build: string;
}

/** The record WaveCode writes for a gate it dispatched: the `gate.result` event payload. Immutable once written. */
export interface GateRecord {
  schema_version: 1;
  sha: string;
  tree_sha: string | null;
  suite: CanonicalSuite;
  label: string | null;
  state: RunState;
  exit_code: number | null;
  run_id: string | null;
  runner: string;
  started_at: string;
  finished_at: string;
  duration_s: number;
  /** The RESULT line and the last lines, for the "why" of an ERROR. */
  steps: { result_line: string | null; tail: string[] };
  reused_from: ReusedFrom | null;
  wavecode_build: string;
}

export const GATE_RESULT_EVENT = 'gate.result';
const LEGACY_GATE_EVENT = 'pipeline.gate';

const SHA40 = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /\b\d{8}-\d{6}-[0-9a-f]{9}-g\d+\b/g;
const RESULT_RE = /^=== RESULT (GREEN|RED)\b(.*)===$/;

// --- build id ------------------------------------------------------------------

let buildId: string | null = null;

/**
 * The running WaveCode: `$WAVECODE_BUILD` when the service sets it, else `<package version>+<git head>`
 * read from the install's `.git` (no process spawn: the server never calls exec synchronously).
 */
export function wavecodeBuild(): string {
  if (buildId) return buildId;
  const env = process.env.WAVECODE_BUILD?.trim();
  if (env) { buildId = env; return buildId; }
  let version = '0';
  try { version = String((JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0'); } catch { /* keep 0 */ }
  let head = '';
  try {
    const root = new URL('../../', import.meta.url);
    const ref = fs.readFileSync(new URL('.git/HEAD', root), 'utf8').trim();
    head = ref.startsWith('ref: ') ? fs.readFileSync(new URL(`.git/${ref.slice(5)}`, root), 'utf8').trim() : ref;
  } catch { /* not a checkout */ }
  buildId = head ? `${version}+${head.slice(0, 7)}` : version;
  return buildId;
}

// --- the judge (pure) ------------------------------------------------------------

export interface JudgeInput {
  sha: string;
  tree_sha: string | null;
  project: string | null;
  require: Requirable[];
  /** Gateway rows filed under the exact SHA. */
  direct: TestRun[];
  /** Gateway rows from the recent history: reused results are filed under the donor, the run id names the target. */
  recent: TestRun[];
  /** WaveCode's own records for the SHA. */
  records: GateRecord[];
  /** Legacy `pipeline.gate` words for the SHA (full gate), oldest first. */
  legacy: Array<{ gate: string; exit_code: number | null; created_at: string }>;
  /** Trees by SHA, for reuse checks. A missing entry means unknown. */
  trees: Map<string, string | null>;
  /** The project's full suites (canonical) for `gate`. */
  fullSuites: CanonicalSuite[];
  now?: Date;
  errors?: string[];
}

function runState(run: TestRun): RunState | null {
  switch (run.state) {
    case 'pass': return 'GREEN';
    case 'fail': return 'RED';
    case 'queued': case 'running': case 'hung': return 'RUNNING';
    default: return null; // superseded, duplicate, cancelled: not evidence
  }
}

function stampOf(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function short(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 8) || '?';
}

function reuseJudgement(target: string, targetTree: string | null, donor: string, trees: Map<string, string | null>): { match: boolean | null; why: string | null; donorTree: string | null } {
  const donorKey = [...trees.keys()].find((k) => k === donor || k.startsWith(donor) || donor.startsWith(k)) ?? donor;
  const donorTree = trees.get(donorKey) ?? null;
  if (!targetTree || !donorTree) return { match: null, why: `reused from ${short(donor)}: ${!targetTree ? `no tree for ${short(target)}` : `no tree for donor ${short(donor)}`}, cannot confirm an identical tree`, donorTree };
  if (targetTree === donorTree) return { match: true, why: null, donorTree };
  return { match: false, why: `tree mismatch with donor ${short(donor)} (target tree ${targetTree.slice(0, 8)}, donor tree ${donorTree.slice(0, 8)})`, donorTree };
}

export function judge(input: JudgeInput): GateStatusReport {
  const sha = input.sha.toLowerCase();
  const found: GateEvidence[] = [];
  const errors = [...(input.errors ?? [])];
  const sha9 = sha.slice(0, 9);

  // gateway rows for the exact SHA
  for (const run of input.direct) {
    const state = runState(run);
    if (!state) continue;
    if ((run.sha ?? '').toLowerCase() !== sha) continue;
    const suite = canonicalSuite(run.suite, run.kind);
    found.push({
      source: 'gateway', run_id: run.id, suite, label: run.suite, state, started_at: run.started_at, finished_at: run.ended_at,
      result_sha: run.sha, reused_from: null, tree_match: null,
      counts: suite !== null, why: suite === null ? `label ${run.suite ?? '(none)'} is not a known suite` : null,
    });
  }
  // gateway rows filed under a donor whose run id names this SHA
  const seen = new Set(found.map((f) => f.run_id));
  for (const run of input.recent) {
    const state = runState(run);
    if (!state || seen.has(run.id)) continue;
    const rowSha = (run.sha ?? '').toLowerCase();
    if (rowSha === sha) {
      if (!input.direct.some((d) => d.id === run.id)) {
        const suite = canonicalSuite(run.suite, run.kind);
        found.push({ source: 'gateway', run_id: run.id, suite, label: run.suite, state, started_at: run.started_at, finished_at: run.ended_at, result_sha: run.sha, reused_from: null, tree_match: null, counts: suite !== null, why: suite === null ? `label ${run.suite ?? '(none)'} is not a known suite` : null });
        seen.add(run.id);
      }
      continue;
    }
    if (!run.id.includes(sha9) || !rowSha) continue;
    const suite = canonicalSuite(run.suite, run.kind);
    const reuse = reuseJudgement(sha, input.tree_sha, rowSha, input.trees);
    const labelWhy = suite === null ? `label ${run.suite ?? '(none)'} is not a known suite` : null;
    found.push({
      source: 'gateway-reuse', run_id: run.id, suite, label: run.suite, state, started_at: run.started_at, finished_at: run.ended_at,
      result_sha: run.sha, reused_from: { sha: rowSha, tree_sha: reuse.donorTree }, tree_match: reuse.match,
      counts: suite !== null && reuse.match === true,
      why: labelWhy ?? (reuse.match === true ? null : `label ${run.suite ?? '(none)'} normalized to ${suite}, ${reuse.why}`),
    });
    seen.add(run.id);
  }
  // WaveCode's own records
  for (const rec of input.records) {
    if ((rec.sha ?? '').toLowerCase() !== sha) continue;
    const suite = isCanonicalSuite(rec.suite) ? rec.suite : null;
    let counts = suite !== null;
    let why: string | null = suite === null ? `record names a non-canonical suite ${rec.suite}` : null;
    let treeMatch: boolean | null = null;
    let reused: ReusedFrom | null = null;
    if (rec.reused_from) {
      const r = reuseJudgement(sha, input.tree_sha ?? rec.tree_sha, rec.reused_from.sha, input.trees);
      const donorTree = r.donorTree ?? rec.reused_from.tree_sha;
      const targetTree = input.tree_sha ?? rec.tree_sha;
      treeMatch = targetTree && donorTree ? targetTree === donorTree : r.match;
      reused = { sha: rec.reused_from.sha, tree_sha: donorTree };
      if (treeMatch !== true) {
        counts = false;
        why = why ?? (treeMatch === false ? `tree mismatch with donor ${short(rec.reused_from.sha)} (target tree ${short(targetTree)}, donor tree ${short(donorTree)})` : r.why);
      }
    }
    if (rec.state === 'ERROR' && counts) { why = `tool error (exit ${rec.exit_code ?? 'none'}): ${rec.steps?.result_line ?? rec.steps?.tail?.slice(-1)[0] ?? 'no RESULT line'}`; }
    found.push({
      source: 'wavecode', run_id: rec.run_id, suite, label: rec.label, state: rec.state, started_at: rec.started_at, finished_at: rec.finished_at,
      result_sha: rec.reused_from?.sha ?? rec.sha, reused_from: reused, tree_match: treeMatch, counts, why,
    });
  }
  // legacy words (full gate only; no run id, no tree)
  for (const l of input.legacy) {
    const word = (l.gate ?? '').toUpperCase();
    const state: RunState | null = word === 'GREEN' ? 'GREEN' : word === 'RED' ? 'RED' : word === 'QUEUED' || word === 'RUNNING' ? 'RUNNING' : null;
    if (!state) continue;
    const fullSuite = input.fullSuites[0] ?? 'full';
    found.push({
      source: 'wavecode-legacy', run_id: null, suite: fullSuite, label: `pipeline.gate ${word}`, state, started_at: null, finished_at: l.created_at,
      result_sha: sha, reused_from: null, tree_match: null, counts: true, why: null,
    });
  }

  const suites: Record<string, SuiteStatus> = {};
  const states: GateState[] = [];
  for (const req of input.require) {
    const wanted: CanonicalSuite[] = req === 'gate' ? input.fullSuites : [req];
    const pool = found.filter((f) => f.counts && f.suite !== null && wanted.includes(f.suite));
    const finished = pool.filter((f) => f.state !== 'RUNNING').sort((a, b) => stampOf(b.finished_at) - stampOf(a.finished_at));
    const running = pool.filter((f) => f.state === 'RUNNING').sort((a, b) => stampOf(b.started_at ?? b.finished_at) - stampOf(a.started_at ?? a.finished_at));
    const pick = finished[0] ?? running[0] ?? null;
    const others = found.filter((f) => f.suite !== null && wanted.includes(f.suite) && !f.counts);
    let note: string;
    if (pick) {
      note = `${pick.state} from ${pick.source} ${pick.run_id ?? ''}`.trim() + (pick.reused_from ? ` (reused from ${short(pick.reused_from.sha)}, identical tree)` : '') + (finished.length > 1 ? `; latest of ${finished.length} finished` : '') + (pick.state !== 'RUNNING' && running.length ? `; ${running.length} still running` : '');
    } else if (others.length) {
      note = `nothing counts for ${req}: ${others.map((o) => `${o.source} ${o.run_id ?? ''} ${o.state} — ${o.why}`.replace(/\s+/g, ' ').trim()).join('; ')}`;
    } else {
      note = `no result for ${req} on ${short(sha)}`;
    }
    const state: GateState = pick ? pick.state : 'MISSING';
    suites[req] = { state, run_id: pick?.run_id ?? null, finished_at: pick?.finished_at ?? null, source: pick?.source ?? null, reused_from: pick?.reused_from ?? null, note };
    states.push(state);
  }
  const verdict: GateState = errors.length ? 'ERROR'
    : states.includes('RED') ? 'RED'
    : states.includes('RUNNING') ? 'RUNNING'
    : states.includes('ERROR') ? 'ERROR'
    : states.includes('MISSING') ? 'MISSING'
    : 'GREEN';
  return {
    schema_version: 1,
    sha,
    tree_sha: input.tree_sha,
    project: input.project,
    require: input.require,
    suites,
    verdict,
    exit_code: gateExitCode(verdict),
    found,
    errors,
    checked_at: (input.now ?? new Date()).toISOString(),
    wavecode_build: wavecodeBuild(),
  };
}

export function gateExitCode(verdict: GateState): GateStatusReport['exit_code'] {
  switch (verdict) {
    case 'GREEN': return 0;
    case 'MISSING': return 2;
    case 'RED': return 3;
    case 'RUNNING': return 4;
    default: return 1;
  }
}

// --- loading -------------------------------------------------------------------------

export function parseRequire(raw: string | string[] | null | undefined): Requirable[] | { error: string } {
  const list = (Array.isArray(raw) ? raw : (raw ?? '').split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return ['quick', 'api'];
  const bad = list.filter((s) => !isRequirable(s));
  if (bad.length) return { error: `unknown suite${bad.length === 1 ? '' : 's'} ${bad.join(', ')} (use ${REQUIRABLE.join(', ')})` };
  return [...new Set(list)] as Requirable[];
}

export async function treeOf(repo: string | null, sha: string): Promise<string | null> {
  if (!repo || !sha) return null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${sha}^{tree}`], { timeout: 5000, encoding: 'utf8' });
    const tree = stdout.trim();
    return SHA40.test(tree) ? tree : null;
  } catch {
    return null;
  }
}

/** The project's full group, canonical (api and/or full): `gate` means any of them green. */
export function fullSuitesOf(project: string | null): CanonicalSuite[] {
  let listed: string[] | undefined;
  try { listed = project ? getConfig().projects?.[project]?.tests?.full_suites : undefined; } catch { listed = undefined; }
  const canon = (listed ?? ['api', 'full-tuned', 'full']).map((s) => canonicalSuite(s)).filter((s): s is CanonicalSuite => s !== null && s !== 'quick');
  return canon.length ? [...new Set(canon)] : ['api', 'full'];
}

export function recordsFor(sha: string): GateRecord[] {
  try {
    const rows = getDb().prepare(`SELECT payload_json FROM events WHERE entity_type = 'run' AND entity_id = ? AND type = ? ORDER BY id ASC`).all(sha.toLowerCase(), GATE_RESULT_EVENT) as Array<{ payload_json: string | null }>;
    const out: GateRecord[] = [];
    for (const r of rows) {
      if (!r.payload_json) continue;
      try { out.push(JSON.parse(r.payload_json) as GateRecord); } catch { /* skip a bad row */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function legacyWordsFor(sha: string): Array<{ gate: string; exit_code: number | null; created_at: string }> {
  try {
    const rows = getDb().prepare(`SELECT payload_json, created_at FROM events WHERE entity_type = 'run' AND entity_id = ? AND type = ? ORDER BY id ASC`).all(`${sha.toLowerCase()}:full`, LEGACY_GATE_EVENT) as Array<{ payload_json: string | null; created_at: string }>;
    const out: Array<{ gate: string; exit_code: number | null; created_at: string }> = [];
    for (const r of rows) {
      if (!r.payload_json) continue;
      try {
        const p = JSON.parse(r.payload_json) as { gate?: string; sha?: string; exit_code?: number };
        if (p.sha && p.sha.toLowerCase() !== sha.toLowerCase()) continue;
        out.push({ gate: String(p.gate ?? ''), exit_code: typeof p.exit_code === 'number' ? p.exit_code : null, created_at: r.created_at });
      } catch { /* skip */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The checker. Reads every source for the exact SHA and judges. Never throws:
 * a bad SHA or an unreachable source is an ERROR verdict with the reason.
 */
export async function checkGateStatus(project: string | null, sha: string, require: Requirable[], opts: { lane?: string | null; now?: Date } = {}): Promise<GateStatusReport> {
  const target = (sha ?? '').trim().toLowerCase();
  const fullSuites = fullSuitesOf(project);
  if (!SHA40.test(target)) {
    return judge({ sha: target || '?', tree_sha: null, project, require, direct: [], recent: [], records: [], legacy: [], trees: new Map(), fullSuites, now: opts.now, errors: [`sha must be the full 40-character SHA, got ${sha ? `${sha.length} characters` : 'nothing'}`] });
  }
  const repo = projectRepo(project);
  const trees = new Map<string, string | null>();
  const targetTree = await treeOf(repo, target);
  trees.set(target, targetTree);
  let direct: TestRun[] = [];
  let recent: TestRun[] = [];
  const errors: string[] = [];
  if (project && testsConfigured(project)) {
    try { direct = await readLaneTests(project, opts.lane ?? '', target); } catch (e) { errors.push(`gateway history for ${short(target)} unreadable: ${(e as Error).message}`); }
    try { recent = await readRecentRuns(project); } catch (e) { logger.debug({ error: (e as Error).message }, 'gate-status: recent history unreadable'); }
  }
  const records = recordsFor(target);
  const legacy = legacyWordsFor(target);
  const donors = new Set<string>();
  for (const r of recent) if (r.sha && r.sha.toLowerCase() !== target && r.id.includes(target.slice(0, 9))) donors.add(r.sha.toLowerCase());
  for (const r of records) if (r.reused_from?.sha) donors.add(r.reused_from.sha.toLowerCase());
  for (const donor of donors) trees.set(donor, await treeOf(repo, donor));
  return judge({ sha: target, tree_sha: targetTree, project, require, direct, recent, records, legacy, trees, fullSuites, now: opts.now, errors });
}

// --- writers ------------------------------------------------------------------------

export interface GateRunInput {
  project: string | null;
  sha: string;
  /** The argv WaveCode ran; the suite label is read from `--suite <s>` / `--full`, default tier1. */
  argv: string[];
  stdout: string;
  exit_code: number | null;
  started_at: Date;
  finished_at: Date;
  /** When the tool failed before any suite ran (gateRefusal / a kill without a RESULT line). */
  dispatch_failure?: string | null;
}

/** The suite label a `countix-remote-test` argv asks for. */
export function suiteLabelOf(argv: string[]): string {
  const i = argv.indexOf('--suite');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (argv.includes('--full')) return 'full';
  const last = argv[argv.length - 1];
  if (last && canonicalSuite(last)) return last;
  return 'tier1';
}

export function parseResultLine(stdout: string): { word: 'GREEN' | 'RED'; sha: string | null; suite: string | null; line: string } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(RESULT_RE);
    if (!m) continue;
    const fields = m[2];
    const sha = fields.match(/\bsha=([0-9a-f]{7,40})\b/)?.[1] ?? null;
    const suite = fields.match(/\bsuite=([\w-]+)/)?.[1] ?? null;
    return { word: m[1] as 'GREEN' | 'RED', sha, suite, line: lines[i] };
  }
  return null;
}

export function runIdOf(stdout: string): string | null {
  const ids = stdout.match(RUN_ID_RE);
  return ids?.length ? ids[ids.length - 1] : null;
}

/**
 * Build the record for a gate WaveCode ran. The RESULT line is the verdict even after a
 * signal exit; no RESULT line and a non-zero exit is a tool ERROR, not a RED; a dispatcher
 * word (QUEUED, RUNNING, DUPLICATE) without a RESULT is RUNNING. A RESULT line naming another
 * SHA is a reused run: the donor and both trees go into the record.
 */
export async function buildGateRecord(input: GateRunInput): Promise<GateRecord> {
  const sha = input.sha.toLowerCase();
  const label = input.argv.length ? suiteLabelOf(input.argv) : 'tier1';
  const result = parseResultLine(input.stdout);
  const suite = assertCanonicalSuite(canonicalSuite(result?.suite ?? label) ?? canonicalSuite(label) ?? 'quick');
  const tail = input.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-5);
  let state: RunState;
  if (result) state = result.word;
  else if (input.dispatch_failure) state = 'ERROR';
  else if (/\b(QUEUED|RUNNING|DUPLICATE)\b/.test(input.stdout) && input.exit_code !== 0) state = 'RUNNING';
  else if (input.exit_code === 0) state = 'GREEN';
  else state = 'ERROR';
  const repo = projectRepo(input.project);
  const tree = await treeOf(repo, sha);
  let reused: ReusedFrom | null = null;
  if (result?.sha && !sha.startsWith(result.sha.toLowerCase()) && !result.sha.toLowerCase().startsWith(sha)) {
    reused = { sha: result.sha.toLowerCase(), tree_sha: await treeOf(repo, result.sha) };
  }
  return {
    schema_version: 1,
    sha,
    tree_sha: tree,
    suite,
    label,
    state,
    exit_code: input.exit_code,
    run_id: runIdOf(input.stdout),
    runner: input.argv[0] ?? 'unknown',
    started_at: input.started_at.toISOString(),
    finished_at: input.finished_at.toISOString(),
    duration_s: Math.max(0, Math.round((input.finished_at.getTime() - input.started_at.getTime()) / 1000)),
    steps: { result_line: result?.line ?? null, tail },
    reused_from: reused,
    wavecode_build: wavecodeBuild(),
  };
}

/** Write the record as one immutable `gate.result` event (entity `run`, id = the SHA). Never throws. */
export async function recordGateResult(input: GateRunInput): Promise<GateRecord | null> {
  try {
    const record = await buildGateRecord(input);
    emit(GATE_RESULT_EVENT, 'run', record.sha, record as unknown as Record<string, unknown>, null);
    return record;
  } catch (e) {
    logger.warn({ sha: input.sha, error: (e as Error).message }, 'gate-status: result not recorded');
    return null;
  }
}

// --- words for the older readers -------------------------------------------------------

export type GateWord = 'green' | 'red' | 'pending' | 'missing';

export function wordOf(state: GateState): GateWord {
  switch (state) {
    case 'GREEN': return 'green';
    case 'RED': return 'red';
    case 'RUNNING': return 'pending';
    default: return 'missing';
  }
}

/** Quick and full-group words for a freeze, from the checker. `missing` where nothing counts. */
export async function gateWordsFor(freeze: { project: string | null; sha: string; lane: string | null }): Promise<{ quick: GateWord; full: GateWord; report: GateStatusReport }> {
  const report = await checkGateStatus(freeze.project, freeze.sha, ['quick', 'gate'], { lane: freeze.lane });
  return { quick: wordOf(report.suites.quick?.state ?? 'MISSING'), full: wordOf(report.suites.gate?.state ?? 'MISSING'), report };
}

/** One line per suite for a human: the state, the run and why. */
export function formatReport(report: GateStatusReport): string {
  const lines: string[] = [`${report.verdict} ${report.sha.slice(0, 8)} (tree ${report.tree_sha ? report.tree_sha.slice(0, 8) : 'unknown'})`];
  for (const [name, s] of Object.entries(report.suites)) lines.push(`  ${name.padEnd(5)} ${s.state.padEnd(7)} ${s.note}`);
  for (const e of report.errors) lines.push(`  error: ${e}`);
  if (report.verdict !== 'GREEN' && report.found.length) {
    lines.push('  found:');
    for (const f of report.found) {
      lines.push(`    ${f.source.padEnd(15)} ${(f.run_id ?? '-').padEnd(36)} ${(f.label ?? '-').padEnd(10)} -> ${f.suite ?? '?'} ${f.state}${f.reused_from ? ` reused_from=${f.reused_from.sha.slice(0, 8)}` : ''}${f.counts ? '' : ` (does not count: ${f.why})`}`);
    }
  }
  return lines.join('\n');
}
