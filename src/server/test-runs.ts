/**
 * Per-project test runner. A configured command prints one JSON object
 * (schema v1). Unknown fields are ignored. A report whose `v` is present and
 * not 1 is rejected. WaveCode never shells the argv out.
 *
 * Staging accepts a green quick check (`suite` in the project's quick suites,
 * default `quick` / `tier1`) or a green full run. Production Promote accepts
 * only a green full run (`kind=gate` or a full suite, default `full-tuned` /
 * `full`) on that same SHA. Both are read from this JSON, ahead of the freeze
 * file's own gate line.
 */

import { execFileAsync } from './proc.js';
import { getConfig, type ProjectConfig } from './config.js';
import logger from './logger.js';

export const TEST_STATES = ['queued', 'running', 'pass', 'fail', 'hung', 'superseded', 'duplicate', 'cancelled'] as const;
export type TestState = (typeof TEST_STATES)[number];
export type TestKind = 'dev' | 'gate';

export interface TestRun {
  /** Null on a queued run that has not been assigned an id yet. A synthetic key is filled in so two queued rows do not collapse. */
  id: string;
  sha: string | null;
  /** Derived from `who` (`wave.<host>.<lane>` → `<lane>`). Null for gates and unknown runs. */
  lane: string | null;
  who: string | null;
  kind: TestKind | null;
  /** `tier1` is stored as `quick`. Anything else is kept as written. */
  suite: string | null;
  state: TestState;
  queue_pos: number | null;
  host: string | null;
  queued_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  wait_s: number | null;
  run_s: number | null;
  failing_step: string | null;
  summary: string | null;
  log: string | null;
  superseded_by: string | null;
}

export interface TestHostError {
  host: string | null;
  msg: string;
}

export interface TestReport {
  generated_at: string | null;
  runs: TestRun[];
  /** A host the runner could not reach. The rest of the document is still valid. */
  errors: TestHostError[];
}

export type LiveGate = 'green' | 'red' | 'pending';

const STATE_SET = new Set<string>(TEST_STATES);

function optStr(obj: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] == null) return null;
  return typeof obj[key] === 'string' ? obj[key] : null;
}

function optNum(obj: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(obj, key) || obj[key] == null) return null;
  return typeof obj[key] === 'number' && Number.isFinite(obj[key]) ? obj[key] as number : null;
}

/** `wave.<host>.ales-codex2` → `ales-codex2`. Gates and `unknown` have no lane. */
export function laneFromWho(who: string | null, kind: TestKind | null): string | null {
  if (kind === 'gate') return null;
  if (!who) return null;
  const trimmed = who.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
  const prefixed = /^wave\.[^.]+\.(.+)$/i.exec(trimmed);
  if (prefixed?.[1]) return prefixed[1];
  if (!trimmed.includes('.') && !trimmed.includes('/')) return trimmed;
  return null;
}

function mapSuite(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const suite = raw.trim().toLowerCase();
  if (suite === 'tier1' || suite === 'quick') return 'quick';
  if (suite === 'full-tuned' || suite === 'full') return 'full-tuned';
  return raw.trim();
}

function parseHostErrors(value: unknown): TestHostError[] {
  if (!Array.isArray(value)) return [];
  const out: TestHostError[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const o = row as Record<string, unknown>;
    const msg = typeof o.msg === 'string' ? o.msg.replace(/\r+$/g, '').trim() : '';
    if (!msg && typeof o.host !== 'string') continue;
    out.push({ host: typeof o.host === 'string' ? o.host : null, msg });
  }
  return out;
}

let queuedKeys = 0;

function parseRun(value: unknown): TestRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const rawState = typeof o.state === 'string' ? o.state.trim().toLowerCase() : '';
  // A timeout is a failure. superseded / duplicate / cancelled are accepted even though not all are emitted yet.
  const state: TestState | null = rawState === 'timeout' ? 'fail' : STATE_SET.has(rawState) ? rawState as TestState : null;
  if (!state) return null;
  const kind = o.kind === 'gate' || o.kind === 'dev' ? o.kind : null;
  const who = optStr(o, 'who');
  const sha = optStr(o, 'sha');
  const explicitId = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
  // Queued rows often have no id yet. Any other state without an id is still shown, keyed so it cannot collide.
  const id = explicitId ?? `anon-${state}-${sha ?? 'nosha'}-${optNum(o, 'queue_pos') ?? queuedKeys++}`;
  const failing = optStr(o, 'failing_step') ?? (rawState === 'timeout' ? 'timeout' : null);
  return {
    id,
    sha,
    lane: laneFromWho(who, kind),
    who,
    kind,
    suite: mapSuite(o.suite),
    state,
    queue_pos: optNum(o, 'queue_pos'),
    host: optStr(o, 'host'),
    queued_at: optStr(o, 'queued_at'),
    started_at: optStr(o, 'started_at'),
    ended_at: optStr(o, 'ended_at'),
    wait_s: optNum(o, 'wait_s'),
    run_s: optNum(o, 'run_s'),
    failing_step: failing,
    summary: optStr(o, 'summary'),
    log: optStr(o, 'log'),
    superseded_by: optStr(o, 'superseded_by'),
  };
}

/** One JSON document. Null when it is not schema v1. A host error does not reject the document. */
export function parseTestReport(text: string): TestReport | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, 'v') && obj.v !== 1) return null;
  if (obj.runs !== undefined && !Array.isArray(obj.runs)) return null;
  const runs: TestRun[] = [];
  for (const row of (obj.runs as unknown[] | undefined) ?? []) {
    const run = parseRun(row);
    if (run) runs.push(run);
  }
  return { generated_at: optStr(obj, 'generated_at'), runs, errors: parseHostErrors(obj.errors) };
}

export const HOST_UNREACHABLE = 'test host unreachable';

export function shaMatch(runSha: string | null, sha: string): boolean {
  if (!runSha || !sha) return false;
  const a = runSha.toLowerCase();
  const b = sha.toLowerCase();
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 7 && long.startsWith(short);
}

function stamp(run: TestRun): number {
  const raw = run.ended_at || run.started_at || run.queued_at;
  const t = raw ? Date.parse(raw) : 0;
  return Number.isFinite(t) ? t : 0;
}

export const DEFAULT_QUICK_SUITES = ['quick', 'tier1'];
export const DEFAULT_FULL_SUITES = ['full-tuned', 'full'];

export function suiteNames(project: string | null): { quick: string[]; full: string[] } {
  const t = projectTests(project);
  const listed = (names: string[] | undefined, fallback: string[]) => {
    const clean = (names ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    return clean.length ? clean : fallback;
  };
  return { quick: listed(t?.quick_suites, DEFAULT_QUICK_SUITES), full: listed(t?.full_suites, DEFAULT_FULL_SUITES) };
}

function suiteTokens(run: TestRun): string[] {
  const raw = (run.suite ?? '').trim().toLowerCase();
  if (!raw) return [];
  const mapped = (mapSuite(raw) ?? raw).toLowerCase();
  return mapped === raw ? [raw] : [raw, mapped];
}

/** A quick check. A gate run is never a quick check, even if its suite name overlaps. */
export function isQuickRun(run: TestRun, names: string[]): boolean {
  if (run.kind === 'gate') return false;
  const set = new Set(names.map((s) => s.toLowerCase()));
  return suiteTokens(run).some((s) => set.has(s));
}

/** A full gate: `kind=gate`, or a suite name in the project's full list. */
export function isFullRun(run: TestRun, names: string[]): boolean {
  if (run.kind === 'gate') return true;
  const set = new Set(names.map((s) => s.toLowerCase()));
  return suiteTokens(run).some((s) => set.has(s));
}

function isGateRun(run: TestRun): boolean {
  return isFullRun(run, DEFAULT_FULL_SUITES);
}

export type CheckState = 'green' | 'red' | 'pending' | 'missing';

export interface ShaChecks {
  quick: CheckState;
  full: CheckState;
  quickRun: TestRun | null;
  fullRun: TestRun | null;
}

function pickCheck(pool: TestRun[]): { state: CheckState; run: TestRun | null } {
  const inflight = pool.filter((r) => r.state === 'queued' || r.state === 'running' || r.state === 'hung');
  if (inflight.length) return { state: 'pending', run: [...inflight].sort((a, b) => stamp(b) - stamp(a))[0] ?? null };
  const done = pool.filter((r) => r.state === 'pass' || r.state === 'fail');
  if (done.length === 0) return { state: 'missing', run: null };
  const newest = [...done].sort((a, b) => {
    const ae = a.ended_at ? Date.parse(a.ended_at) : 0;
    const be = b.ended_at ? Date.parse(b.ended_at) : 0;
    return (Number.isFinite(be) ? be : 0) - (Number.isFinite(ae) ? ae : 0);
  })[0] ?? null;
  if (!newest) return { state: 'missing', run: null };
  return { state: newest.state === 'pass' ? 'green' : 'red', run: newest };
}

/** Quick and full results on one SHA. An in-flight run wins over an older finished one. A later fail beats an earlier pass. */
export function shaChecks(runs: TestRun[], sha: string, names: { quick: string[]; full: string[] }): ShaChecks {
  const onSha = runs.filter((r) => shaMatch(r.sha, sha) && r.state !== 'superseded' && r.state !== 'duplicate' && r.state !== 'cancelled');
  const quick = pickCheck(onSha.filter((r) => isQuickRun(r, names.quick)));
  const full = pickCheck(onSha.filter((r) => isFullRun(r, names.full)));
  return { quick: quick.state, full: full.state, quickRun: quick.run, fullRun: full.run };
}

/**
 * Runs that belong on this card. Gate runs match the freeze SHA only (40-hex
 * or a prefix) — their lane is null. A dev run matches its derived lane or SHA.
 */
export function runsForCard(runs: TestRun[], sha: string, lane?: string | null): TestRun[] {
  return runs.filter((r) => {
    if (isGateRun(r)) return shaMatch(r.sha, sha);
    if (lane && r.lane === lane) return true;
    return !!r.sha && shaMatch(r.sha, sha);
  });
}

/** The chip prefers an in-flight run. A running gate is shown as running even when an older gate on the same SHA already finished. */
export function selectChipRun(runs: TestRun[], sha: string, lane?: string | null): TestRun | null {
  const pool = runsForCard(runs, sha, lane);
  if (pool.length === 0) return null;
  const hot = pool.filter((r) => r.state === 'queued' || r.state === 'running' || r.state === 'hung');
  const list = hot.length ? hot : pool;
  return [...list].sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
}

function gateRunsOnSha(runs: TestRun[], sha: string): TestRun[] {
  return runs.filter((r) => shaMatch(r.sha, sha) && isGateRun(r) && r.state !== 'superseded' && r.state !== 'duplicate' && r.state !== 'cancelled');
}

/** Newest finished gate on this SHA. A later fail beats an earlier pass. Offloaded runs count once, under their host. */
export function finishedGate(runs: TestRun[], sha: string): TestRun | null {
  const done = gateRunsOnSha(runs, sha).filter((r) => r.state === 'pass' || r.state === 'fail');
  if (done.length === 0) return null;
  return [...done].sort((a, b) => {
    const ae = a.ended_at ? Date.parse(a.ended_at) : 0;
    const be = b.ended_at ? Date.parse(b.ended_at) : 0;
    return (Number.isFinite(be) ? be : 0) - (Number.isFinite(ae) ? ae : 0);
  })[0] ?? null;
}

export function inflightGate(runs: TestRun[], sha: string): TestRun | null {
  const open = gateRunsOnSha(runs, sha).filter((r) => r.state === 'queued' || r.state === 'running' || r.state === 'hung');
  if (open.length === 0) return null;
  return [...open].sort((a, b) => stamp(b) - stamp(a))[0] ?? null;
}

/**
 * While a gate is queued, running, or hung, the state is pending so the chip
 * says so. Otherwise the newest finished gate is GREEN or RED.
 */
export function liveGateForRuns(runs: TestRun[], sha: string): LiveGate | null {
  if (inflightGate(runs, sha)) return 'pending';
  const done = finishedGate(runs, sha);
  if (!done) return null;
  return done.state === 'pass' ? 'green' : 'red';
}

export function clockSpan(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  return `${Math.round(seconds / 60)}m`;
}

/** The bit after "Full run:" on a card that is already on staging. */
export function fullRunPhrase(run: TestRun | null): string {
  if (!run) return 'not run';
  if (run.state === 'queued') return `queued #${run.queue_pos ?? '?'}`;
  if (run.state === 'running') {
    const elapsed = run.run_s != null ? clockSpan(run.run_s) : '';
    if (elapsed && run.host) return `running ${elapsed} on ${run.host}`;
    if (run.host) return `running on ${run.host}`;
    if (elapsed) return `running ${elapsed}`;
    return 'running';
  }
  if (run.state === 'hung') return run.host ? `HUNG on ${run.host}` : 'HUNG';
  if (run.state === 'pass') return 'PASS';
  if (run.state === 'fail') return `FAIL: ${run.failing_step || 'failed'}`;
  return run.state.toUpperCase();
}

export function testsConfigured(project: string | null): boolean {
  const t = projectTests(project);
  return !!(t?.status_command?.length || t?.history_command?.length);
}

/** Short label drawn on the chip. */
export function testChipLabel(run: TestRun): string {
  switch (run.state) {
    case 'queued': {
      const pos = run.queue_pos != null ? `#${run.queue_pos}` : '#?';
      const wait = run.wait_s != null ? `, waiting ${clockSpan(run.wait_s)}` : '';
      return `queued (${pos}${wait})`;
    }
    case 'running': {
      const bits = [run.host, run.suite, run.run_s != null ? clockSpan(run.run_s) : null].filter((x): x is string => !!x);
      return bits.length ? `running (${bits.join(', ')})` : 'running';
    }
    case 'pass': return 'PASS';
    case 'fail': return run.failing_step ? `FAIL: ${run.failing_step}` : 'FAIL';
    case 'hung': return 'HUNG';
    case 'superseded': return `SUPERSEDED${run.superseded_by ? ` (by ${run.superseded_by.slice(0, 8)})` : ''}`;
    case 'duplicate': return 'DUPLICATE';
    case 'cancelled': return 'CANCELLED';
  }
}

const WHOLE = /^\{(sha|lane|id|log)\}$/;

/** Fill `{sha}` `{lane}` `{id}` `{log}`. An empty whole-arg placeholder drops itself and a preceding `--flag`. */
export function fillTestArgv(template: string[], vars: { sha?: string | null; lane?: string | null; id?: string | null; log?: string | null }): string[] {
  const value = (key: string): string => {
    const v = vars[key as keyof typeof vars];
    return v == null ? '' : String(v);
  };
  const out: string[] = [];
  for (const arg of template) {
    const whole = WHOLE.exec(arg);
    if (whole) {
      const filled = value(whole[1]);
      if (!filled) {
        if (out.length > 0 && out[out.length - 1].startsWith('--')) out.pop();
        continue;
      }
      out.push(filled);
      continue;
    }
    out.push(arg.replace(/\{(sha|lane|id|log)\}/g, (_, key: string) => value(key)));
  }
  return out;
}

type ExecFn = (argv: string[]) => string | Promise<string>;
let testExec: ExecFn | null = null;
let ttlMs = 20_000;
const cache = new Map<string, { at: number; report: TestReport }>();
let timer: ReturnType<typeof setInterval> | null = null;
let pollTargets: Array<{ project: string; lane: string; sha: string }> = [];

export function setTestRunExecForTest(fn: ExecFn | null): void {
  testExec = fn;
  cache.clear();
}

export function setTestRunTtlForTest(ms: number): void {
  ttlMs = ms;
}

export function projectTests(project: string | null): ProjectConfig['tests'] | undefined {
  if (!project) return undefined;
  return getConfig().projects?.[project]?.tests;
}

export function hasLogCommand(project: string | null): boolean {
  return !!projectTests(project)?.log_command?.length;
}

async function runCommand(argv: string[]): Promise<string | null> {
  if (argv.length === 0) return null;
  try {
    if (testExec) return await testExec(argv);
    return await execFileAsync(argv[0], argv.slice(1), { timeout: 8000, maxBuffer: 2 * 1024 * 1024 });
  } catch (e) {
    logger.debug({ argv: argv[0], error: (e as Error).message }, 'Test runner command failed');
    return null;
  }
}

export interface ReadOptions {
  /** Serve a cached report up to this old instead of asking the runner (the TTL when smaller). */
  staleOkMs?: number;
}

/**
 * Every runner command is an ssh to the test server. At most this many run at once;
 * identical reads share one command; a cached report is served while it is fresh.
 * (On 25 Oct 2026 a pass over 4,923 freezes sent ~950 commands a minute.)
 */
const MAX_RUNNER_COMMANDS = 3;
let runnerActive = 0;
const runnerWaiters: Array<() => void> = [];
const pendingReads = new Map<string, Promise<TestReport>>();

async function withRunnerSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (runnerActive >= MAX_RUNNER_COMMANDS) await new Promise<void>((resolve) => runnerWaiters.push(resolve));
  else runnerActive++;
  try {
    return await fn();
  } finally {
    const next = runnerWaiters.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else runnerActive--;
  }
}

export function runnerLoadForTest(): { active: number; waiting: number; pending: number } {
  return { active: runnerActive, waiting: runnerWaiters.length, pending: pendingReads.size };
}

async function readCommand(project: string, which: 'status_command' | 'history_command', lane: string, sha: string, opts: ReadOptions = {}): Promise<TestReport | null> {
  const cmd = projectTests(project)?.[which];
  if (!cmd?.length) return null;
  const key = `${which}:${project}:${lane}:${sha}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < Math.max(ttlMs, opts.staleOkMs ?? 0)) return hit.report;
  const joined = pendingReads.get(key);
  if (joined) return joined;
  const argv = fillTestArgv(cmd, { lane, sha });
  const job = withRunnerSlot(async () => {
    const text = await runCommand(argv);
    const report = text ? parseTestReport(text) : null;
    const stored = report ?? { generated_at: null, runs: [], errors: [] };
    cache.set(key, { at: Date.now(), report: stored });
    return stored;
  }).finally(() => pendingReads.delete(key));
  pendingReads.set(key, job);
  return job;
}

function cachedReport(project: string, which: 'status_command' | 'history_command', lane: string, sha: string): TestReport | null {
  return cache.get(`${which}:${project}:${lane}:${sha}`)?.report ?? null;
}

/** What the cache holds for the SHA, however old; null when nothing was ever read. */
export function readCachedLaneTests(project: string, lane: string, sha: string): TestRun[] | null {
  const status = cachedReport(project, 'status_command', lane, sha);
  const history = cachedReport(project, 'history_command', lane, sha);
  if (!status && !history) return null;
  const byId = new Map<string, TestRun>();
  for (const run of history?.runs ?? []) byId.set(run.id, run);
  for (const run of status?.runs ?? []) byId.set(run.id, run);
  return [...byId.values()];
}

/** Age of a freeze from its `created_at` (sqlite `datetime('now')` or ISO); NaN when unreadable. */
export function freezeAgeMs(createdAt: string, now = Date.now()): number {
  const text = createdAt.trim();
  const parsed = /(?:Z|[+-]\d\d:?\d\d)$/.test(text) ? Date.parse(text) : Date.parse(`${text.replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? now - parsed : Number.NaN;
}

export const LIVE_TEST_WINDOW_MS = 3 * 24 * 3600_000;
export const OLD_FREEZE_STALE_OK_MS = 6 * 3600_000;
/** Words that a new run on the same SHA will not change. */
export const TEST_WORDS_SETTLED: ReadonlySet<string> = new Set(['green', 'red', 'unconfigured']);

/**
 * Test runs for a reconcile pass, read sparingly. An open freeze under three days
 * old is read live (the TTL); an older open one at most every six hours, and not at
 * all once its words are settled. Every other freeze — behind main, merged, stale —
 * is answered from the cache, unless its words were still pending: its runs were
 * submitted while it was open, and the hot poller keeps a run in flight fresh.
 * `null` means nothing is cached: the caller keeps the words it already has.
 */
export async function readLaneTestsSparingly(
  freeze: { project: string | null; lane: string | null; sha: string; status: string; created_at: string },
  words: { settled: boolean; pending: boolean },
  now = Date.now(),
): Promise<TestRun[] | null> {
  if (!freeze.project || !testsConfigured(freeze.project)) return [];
  const lane = freeze.lane ?? '';
  if (freeze.status !== 'open') {
    return words.pending ? readLaneTests(freeze.project, lane, freeze.sha, { staleOkMs: OLD_FREEZE_STALE_OK_MS }) : readCachedLaneTests(freeze.project, lane, freeze.sha);
  }
  const age = freezeAgeMs(freeze.created_at, now);
  if (!Number.isFinite(age) || age <= LIVE_TEST_WINDOW_MS) return readLaneTests(freeze.project, lane, freeze.sha);
  if (words.settled) return readCachedLaneTests(freeze.project, lane, freeze.sha);
  return readLaneTests(freeze.project, lane, freeze.sha, { staleOkMs: OLD_FREEZE_STALE_OK_MS });
}

export interface LaneTests {
  runs: TestRun[];
  errors: TestHostError[];
}

/** Status and history merged by id. Status wins when both name the same run. Host errors are kept. */
export async function readLaneReport(project: string, lane: string, sha: string, opts: ReadOptions = {}): Promise<LaneTests> {
  const status = await readCommand(project, 'status_command', lane, sha, opts);
  const history = await readCommand(project, 'history_command', lane, sha, opts);
  const byId = new Map<string, TestRun>();
  for (const run of history?.runs ?? []) byId.set(run.id, run);
  for (const run of status?.runs ?? []) byId.set(run.id, run);
  const errors = [...(history?.errors ?? []), ...(status?.errors ?? [])];
  return { runs: [...byId.values()], errors };
}

export async function readLaneTests(project: string, lane: string, sha: string, opts: ReadOptions = {}): Promise<TestRun[]> {
  return (await readLaneReport(project, lane, sha, opts)).runs;
}

const RECENT_LIMIT = 100; // the gateway's jq breaks above ~150 rows (26 Oct 2026)
const RECENT_TTL_MS = 30_000;

/**
 * The gateway's recent runs regardless of SHA: `history_command` with its `--sha <sha>` pair
 * replaced by `--limit 100`. The checker scans it for results the gateway filed under a donor
 * SHA (the run id names the requesting SHA). Cached for 30 s; one ssh at a time like every read.
 */
export async function readRecentRuns(project: string): Promise<TestRun[]> {
  const cmd = projectTests(project)?.history_command;
  if (!cmd?.length) return [];
  const argv: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === '--sha' && i + 1 < cmd.length) { i++; continue; }
    if (cmd[i].includes('{sha}')) continue;
    argv.push(cmd[i]);
  }
  if (!argv.includes('--limit')) argv.push('--limit', String(RECENT_LIMIT));
  const key = `recent:${project}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < RECENT_TTL_MS) return hit.report.runs;
  const joined = pendingReads.get(key);
  if (joined) return (await joined).runs;
  const job = withRunnerSlot(async () => {
    const text = await runCommand(argv);
    const report = (text ? parseTestReport(text) : null) ?? { generated_at: null, runs: [], errors: [] };
    cache.set(key, { at: Date.now(), report });
    return report;
  }).finally(() => pendingReads.delete(key));
  pendingReads.set(key, job);
  return (await job).runs;
}

export async function liveGateFor(project: string | null, sha: string, lane?: string | null): Promise<LiveGate | null> {
  if (!project || !projectTests(project)?.status_command) return null;
  const runs = await readLaneTests(project, lane ?? '', sha);
  return liveGateForRuns(runs, sha);
}

export async function readTestLog(project: string, run: { id: string; lane?: string | null; sha?: string | null; log?: string | null }): Promise<string | null> {
  const cmd = projectTests(project)?.log_command;
  if (!cmd?.length) return null;
  const argv = fillTestArgv(cmd, { id: run.id, lane: run.lane, sha: run.sha, log: run.log });
  return runCommand(argv);
}

const POLL_MS = 20_000;

/** At most this many lanes are polled for a run in flight; the board read covers the rest. */
const MAX_POLL_TARGETS = 40;

function inFlight(run: TestRun): boolean {
  return run.state === 'queued' || run.state === 'running';
}

/** The targets whose own runs are in flight: a run on the target's SHA, or on its lane without a SHA. */
function hotTargets(targets: Array<{ project: string; lane: string; sha: string }>, runs: TestRun[]): Array<{ project: string; lane: string; sha: string }> {
  const live = runs.filter(inFlight);
  if (live.length === 0) return [];
  return targets.filter((t) => live.some((r) => {
    const sha = (r.sha ?? '').toLowerCase();
    if (sha) return t.sha.toLowerCase().startsWith(sha) || sha.startsWith(t.sha.toLowerCase());
    return !!r.lane && r.lane === t.lane;
  })).slice(0, MAX_POLL_TARGETS);
}

async function pollOnce(): Promise<void> {
  const still: typeof pollTargets = [];
  for (const t of pollTargets) {
    cache.delete(`status_command:${t.project}:${t.lane}:${t.sha}`);
    const runs = await readLaneTests(t.project, t.lane, t.sha);
    if (hotTargets([t], runs).length > 0) still.push(t);
  }
  pollTargets = still;
  if (still.length === 0) stopTestRunPoller();
}

export function pollTargetsForTest(): Array<{ project: string; lane: string; sha: string }> {
  return [...pollTargets];
}

/**
 * Keep reading the lanes that have a run queued or running, and only those.
 * Polling every lane on the board while any run anywhere was in flight sent
 * one status command per lane every 20 s: with 200 lanes, 600 a minute.
 */
export function watchTestRuns(targets: Array<{ project: string; lane: string; sha: string }>, runs: TestRun[]): void {
  pollTargets = hotTargets(targets, runs);
  if (pollTargets.length === 0) {
    stopTestRunPoller();
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void pollOnce().catch((err) => {
      logger.debug({ error: (err as Error).message }, 'Test-run poll failed');
    });
  }, POLL_MS);
  timer.unref?.();
}

export function stopTestRunPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
