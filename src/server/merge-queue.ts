/**
 * Merge queue for a project's main branch (docs/merge-queue.md). Approved by
 * Denis on 25 Oct 2026 for Wavepulse main only: WaveCode merges eligible lanes
 * itself, serially, in a checkout it owns. Agents still never push to main.
 *
 * A freeze is eligible when its note names the exact SHA and a tier, the quick
 * check and the API gate are green on that exact SHA, the tier's reviews are
 * in, the remote lane still points at that SHA, a pull request exists, and any
 * new migration is numbered after main's latest. The queue then merges the lane
 * onto the current main with `--no-ff`, runs the gate on the result, pushes
 * plainly, and tells the author and the coordinating bot. Red or conflicting
 * work bounces to the author. Nothing here force-pushes, squashes, stages, or
 * touches production. The kill switch is the config flag plus a runtime flag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, type MergeQueueConfig, type MergeTier } from './config.js';
import { getAgent, getDb, listAgents, type Agent } from './db.js';
import { emit } from './event-bus.js';
import { gateOutcome, laneRefError, type ExecOptions } from './lane-pipeline.js';
import { changedFiles, mainSpec, projectRepo, resolveMainRef } from './lane-main.js';
import logger from './logger.js';
import { fireMainAdvanced } from './pipeline-hooks.js';
import { execFileAsync } from './proc.js';
import { getFreeze, listFreezes, listVerdicts, viewShaChecks, type FreezeVerdict, type ReleaseFreeze } from './release-freezes.js';
import { readLaneTests, testsConfigured } from './test-runs.js';
import { deliverSystemLine } from './wire-lines.js';

export type QueueState = 'waiting' | 'queued' | 'merging' | 'merged' | 'bounced' | 'superseded';

export interface MergeQueueRow {
  sha: string;
  project: string;
  lane: string;
  tier: MergeTier | null;
  state: QueueState;
  reason: string | null;
  priority: number;
  eligible_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  merge_sha: string | null;
  pr: string | null;
  gate_runs: string | null;
  verdict_files: string | null;
  enabled_by: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface QueueSwitch {
  project: string;
  /** `pipeline.merge_queue.enabled` in config. */
  config_enabled: boolean;
  /** Config on and the runtime flag not off. */
  enabled: boolean;
  enabled_by: string | null;
  queued: number;
}

export interface Eligibility {
  state: 'waiting' | 'queued' | 'bounced';
  reason: string | null;
  tier: MergeTier | null;
  pr: string | null;
  verdictFiles: string[];
}

export const MERGE_QUEUE_EVENT = {
  merged: 'merge_queue.merged',
  bounced: 'merge_queue.bounced',
  queued: 'merge_queue.queued',
  switch: 'merge_queue.switch',
  requeued: 'merge_queue.requeued',
} as const;

type ExecResult = { code: number; stdout: string };
/** Test hook: return a result to fake the command, or null to run it for real. */
let execForTest: ((argv: string[], opts: ExecOptions) => ExecResult | null) | null = null;
export function setMergeQueueExecForTest(fn: typeof execForTest): void { execForTest = fn; }

const inflight = new Map<string, Promise<void>>();
let recovered = false;

// --- storage ------------------------------------------------------------------

export function ensureMergeQueueTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS merge_queue (
      sha TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      lane TEXT NOT NULL,
      tier TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      eligible_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      merge_sha TEXT,
      pr TEXT,
      gate_runs TEXT,
      verdict_files TEXT,
      enabled_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function withTable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!/no such table: merge_queue/.test((e as Error).message)) throw e;
    ensureMergeQueueTable();
    return fn();
  }
}

export function getQueueRow(sha: string): MergeQueueRow | null {
  return withTable(() => (getDb().prepare('SELECT * FROM merge_queue WHERE sha = ?').get(sha) as MergeQueueRow | undefined) ?? null);
}

export function listQueue(project?: string | null): MergeQueueRow[] {
  return withTable(() => (project
    ? getDb().prepare('SELECT * FROM merge_queue WHERE project = ? ORDER BY priority DESC, eligible_at, created_at').all(project)
    : getDb().prepare('SELECT * FROM merge_queue ORDER BY priority DESC, eligible_at, created_at').all()) as MergeQueueRow[]);
}

function upsert(row: Pick<MergeQueueRow, 'sha' | 'project' | 'lane'> & Partial<MergeQueueRow>): MergeQueueRow {
  return withTable(() => {
    const existing = getQueueRow(row.sha);
    if (!existing) {
      getDb().prepare(`INSERT INTO merge_queue (sha, project, lane, tier, state, reason, priority, eligible_at, pr, verdict_files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.sha, row.project, row.lane, row.tier ?? null, row.state ?? 'waiting', row.reason ?? null, row.priority ?? 0,
          row.eligible_at ?? null, row.pr ?? null, row.verdict_files ?? null);
    } else {
      const patch: Record<string, unknown> = {};
      for (const key of ['lane', 'tier', 'state', 'reason', 'priority', 'eligible_at', 'started_at', 'finished_at', 'merge_sha', 'pr', 'gate_runs', 'verdict_files', 'enabled_by', 'attempts'] as const) {
        if (row[key] !== undefined) patch[key] = row[key];
      }
      const keys = Object.keys(patch);
      if (keys.length) {
        getDb().prepare(`UPDATE merge_queue SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE sha = ?`)
          .run(...keys.map((k) => patch[k]), row.sha);
      }
    }
    return getQueueRow(row.sha)!;
  });
}

export function setQueuePriority(sha: string, priority: number): MergeQueueRow | null {
  const row = getQueueRow(sha);
  if (!row) return null;
  return upsert({ sha, project: row.project, lane: row.lane, priority: Math.max(0, Math.min(9, Math.trunc(priority))) });
}

// --- switches -----------------------------------------------------------------

function mqConfig(project: string | null): MergeQueueConfig | null {
  if (!project) return null;
  const raw = getConfig().projects?.[project]?.pipeline?.merge_queue;
  return raw && typeof raw === 'object' ? raw : null;
}

function kvGet(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch { return null; }
}

function kvSet(key: string, value: string): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  getDb().prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function configuredProjects(): string[] {
  return Object.entries(getConfig().projects ?? {}).filter(([, p]) => p.pipeline?.merge_queue?.enabled === true).map(([name]) => name);
}

/** Config on and the runtime flag not off. The flag defaults to on when the config enables the queue. */
export function queueEnabled(project: string): boolean {
  if (mqConfig(project)?.enabled !== true) return false;
  return kvGet(`merge_queue.${project}`) !== 'off';
}

export function queueSwitch(project: string): QueueSwitch {
  const config_enabled = mqConfig(project)?.enabled === true;
  const queued = withTable(() => (getDb().prepare("SELECT COUNT(*) AS n FROM merge_queue WHERE project = ? AND state IN ('queued', 'merging')").get(project) as { n: number }).n);
  return { project, config_enabled, enabled: config_enabled && queueEnabled(project), enabled_by: kvGet(`merge_queue.${project}.by`), queued };
}

/** The kill switch. Who flipped it is kept for the audit row of every later merge. */
export function setQueueSwitch(project: string, enabled: boolean, who: string | null): QueueSwitch {
  kvSet(`merge_queue.${project}`, enabled ? 'on' : 'off');
  kvSet(`merge_queue.${project}.by`, who ?? 'unknown');
  emit(MERGE_QUEUE_EVENT.switch, 'project', project, { project, enabled, by: who }, null);
  return queueSwitch(project);
}

// --- tiers -------------------------------------------------------------------

const TIER_RE = /^\s*(?:[-*>]\s*)?\**\s*TIER\s*\**\s*[:：]\s*\**\s*(ship|show|ask)\b/im;

export function tierFromNote(text: string | null): MergeTier | null {
  if (!text) return null;
  const m = text.match(TIER_RE);
  return m ? (m[1].toLowerCase() as MergeTier) : null;
}

function globRe(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const leading = g.startsWith('**/') ? '(?:.*/)?' : '';
  if (leading) g = g.slice(3);
  const wild = /[*?]/.test(g);
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  // A plain path names a file or a directory; a glob matches exactly what it says.
  return new RegExp(`^${leading}${body}${wild ? '' : '(?:/.*)?'}$`);
}

/** Files under an `ask_paths` glob or the migrations directory raise the tier to `ask`. */
export function askPathHit(files: string[], asks: string[], migrationsDir: string | null | undefined): string | null {
  const globs = [...asks, ...(migrationsDir ? [migrationsDir] : [])].filter((g) => g && g.trim());
  const res = globs.map((g) => ({ g, re: globRe(g) }));
  for (const file of files) {
    const hit = res.find(({ re }) => re.test(file));
    if (hit) return file;
  }
  return null;
}

export function tierFor(note: string | null, files: string[], cfg: MergeQueueConfig, migrationsDir: string | null | undefined): { tier: MergeTier | null; forced: string | null } {
  const forced = askPathHit(files, cfg.ask_paths ?? [], migrationsDir);
  if (forced) return { tier: 'ask', forced };
  return { tier: tierFromNote(note) ?? cfg.default_tier ?? null, forced: null };
}

// --- reviews -----------------------------------------------------------------

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Tier `ask`: two PASS verdicts from reviewers who are not the author, on
 * different credential profiles. The author's own seats never count.
 */
export function askVerdicts(verdicts: FreezeVerdict[], author: { id: string | null; name: string | null }): { ok: boolean; passes: FreezeVerdict[]; why: string | null } {
  const passes: FreezeVerdict[] = [];
  const profiles = new Set<string>();
  for (const v of verdicts) {
    if (v.verdict !== 'pass') continue;
    if (sameName(v.reviewer_name, author.name) || (author.id && v.reviewer_agent_id === author.id)) continue;
    const profileKey = v.profile ?? 'home';
    if (profiles.has(profileKey)) continue;
    passes.push(v);
    profiles.add(profileKey);
  }
  if (passes.length >= 2) return { ok: true, passes, why: null };
  const names = passes.map((p) => `@${p.reviewer_name}`).join(', ');
  return { ok: false, passes, why: `ask tier needs 2 PASS verdicts on different profiles, has ${passes.length}${names ? ` (${names})` : ''}` };
}

// --- git ---------------------------------------------------------------------

async function git(repo: string, args: string[], timeout = 20000): Promise<string> {
  const out = await execFileAsync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'user.name=wavecode', '-c', 'user.email=wavecode@localhost', ...args], {
    timeout, maxBuffer: 8 * 1024 * 1024,
  });
  return out.trim();
}

async function tryGit(repo: string, args: string[], timeout = 20000): Promise<string | null> {
  try { return await git(repo, args, timeout); } catch { return null; }
}

async function runArgv(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (argv.length === 0) return { code: 1, stdout: '' };
  if (execForTest) {
    const faked = execForTest(argv, opts);
    if (faked) return faked;
  }
  try {
    const stdout = await execFileAsync(argv[0], argv.slice(1), {
      timeout: opts.timeoutMs ?? 20000,
      maxBuffer: 8 * 1024 * 1024,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number | null; code?: number | string | null; stdout?: string };
    const code = typeof err.status === 'number' ? err.status : typeof err.code === 'number' ? err.code : 1;
    return { code, stdout: String(err.stdout ?? '') };
  }
}

function fill(template: string[], vars: Record<string, string>): string[] {
  return template.map((arg) => arg.replace(/\{(workspace|lane|sha|remote|project|checkout)\}/g, (_, key: string) => vars[key] ?? ''));
}

/** The remote lane tip, after a fetch. Null when the lane is not on the remote. */
async function remoteTip(repo: string, remote: string, lane: string): Promise<string | null> {
  if (laneRefErrorFree(lane) === false) return null;
  const fetched = await tryGit(repo, ['fetch', '--quiet', remote, lane], 60000);
  if (fetched === null) return null;
  const sha = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${lane}^{commit}`]);
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

function laneRefErrorFree(lane: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(lane);
}

// --- pull requests -------------------------------------------------------------

interface PrItem { number?: number | string; head?: string; headRefOid?: string; sha?: string; branch?: string; headRefName?: string; state?: string }

export function prFromList(json: string, sha: string, lane: string): string | null {
  let items: PrItem[];
  try {
    const parsed = JSON.parse(json) as unknown;
    items = Array.isArray(parsed) ? parsed as PrItem[] : [];
  } catch { return null; }
  const open = items.filter((it) => !it.state || /^open$/i.test(String(it.state)));
  const bySha = open.find((it) => [it.head, it.headRefOid, it.sha].some((s) => typeof s === 'string' && s.toLowerCase() === sha.toLowerCase()));
  const byLane = open.find((it) => [it.branch, it.headRefName].some((b) => typeof b === 'string' && b === lane));
  const hit = bySha ?? byLane;
  return hit?.number !== undefined ? `#${hit.number}` : null;
}

async function findPr(repo: string, remote: string, sha: string, lane: string, cfg: MergeQueueConfig): Promise<string | null> {
  if (cfg.pr_list_command?.length) {
    const result = await runArgv(fill(cfg.pr_list_command, { lane, sha, remote }), { cwd: repo, timeoutMs: 30000 });
    if (result.code !== 0) return null;
    return prFromList(result.stdout, sha, lane);
  }
  const refs = await tryGit(repo, ['ls-remote', remote, 'refs/pull/*/head'], 60000);
  if (!refs) return null;
  for (const line of refs.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/pull\/(\d+)\/head$/i);
    if (m && m[1].toLowerCase() === sha.toLowerCase()) return `#${m[2]}`;
  }
  return null;
}

// --- migrations ----------------------------------------------------------------

const MIGRATION_NUMBER_RE = /^(\d{3,})[_-]/;

/**
 * New migrations in the lane must be numbered above main's latest and not
 * collide with each other. Returns the problem, or null.
 */
export function migrationCollision(mainFiles: string[], laneAdded: string[]): string | null {
  const num = (file: string) => { const m = path.basename(file).match(MIGRATION_NUMBER_RE); return m ? Number(m[1]) : null; };
  const mainMax = Math.max(-1, ...mainFiles.map(num).filter((n): n is number => n !== null));
  const seen = new Map<number, string>();
  for (const file of laneAdded) {
    const n = num(file);
    if (n === null) continue;
    if (n <= mainMax) return `migration ${path.basename(file)} is not numbered after main's latest (${String(mainMax).padStart(4, '0')})`;
    const dup = seen.get(n);
    if (dup) return `migrations ${path.basename(dup)} and ${path.basename(file)} share a number`;
    seen.set(n, file);
  }
  return null;
}

async function migrationProblem(repo: string, mainRef: string, sha: string, dir: string | null | undefined): Promise<string | null> {
  if (!dir) return null;
  const base = await tryGit(repo, ['merge-base', mainRef, sha]);
  if (!base) return null;
  const added = (await tryGit(repo, ['diff', '--name-only', '--diff-filter=A', base, sha, '--', dir]))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
  if (added.length === 0) return null;
  const onMain = (await tryGit(repo, ['ls-tree', '--name-only', mainRef, `${dir.replace(/\/$/, '')}/`]))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
  return migrationCollision(onMain, added);
}

// --- eligibility ---------------------------------------------------------------

function readNote(file: string | null): string | null {
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

async function gateWords(freeze: ReleaseFreeze): Promise<{ quick: string; full: string }> {
  const runs = freeze.project && testsConfigured(freeze.project)
    ? await readLaneTests(freeze.project, freeze.lane ?? '', freeze.sha).catch(() => [])
    : undefined;
  const view = await viewShaChecks(freeze, runs);
  return { quick: view.quick, full: view.full };
}

/** Why a freeze is not merged yet, or `queued` when everything is in. Pure of side effects besides git fetches. */
export async function evaluate(freeze: ReleaseFreeze): Promise<Eligibility> {
  const none: Eligibility = { state: 'waiting', reason: null, tier: null, pr: null, verdictFiles: [] };
  const project = freeze.project;
  const cfg = mqConfig(project);
  if (!project || !cfg || !freeze.lane) return { ...none, reason: 'not a merge-queue project' };
  const laneErr = laneRefError(project, freeze.lane);
  if (laneErr) return { ...none, reason: laneErr };
  const repo = projectRepo(project);
  if (!repo) return { ...none, reason: 'project has no repo' };
  const spec = mainSpec(project);
  const mainRef = await resolveMainRef(repo, project);
  if (!mainRef) return { ...none, reason: `${spec.ref} not found` };
  const migrationsDir = getConfig().projects?.[project]?.migrations_dir ?? null;

  const files = await changedFiles(repo, freeze.sha, mainRef).catch(() => [] as string[]);
  const note = readNote(freeze.freeze_path);
  const { tier, forced } = tierFor(note, files, cfg, migrationsDir);
  if (!tier) return { ...none, reason: 'freeze note has no TIER line (ship, show or ask)' };
  const base: Eligibility = { ...none, tier };

  // Any commit after the review invalidates it: the remote lane must still be this SHA.
  const tip = await remoteTip(repo, spec.remote, freeze.lane);
  if (!tip) return { ...base, reason: `${freeze.lane} is not on ${spec.remote}` };
  if (tip.toLowerCase() !== freeze.sha.toLowerCase()) return { ...base, reason: `lane moved to ${tip.slice(0, 8)} after the freeze; freeze that SHA` };

  const gates = await gateWords(freeze);
  if (gates.quick !== 'green' || gates.full !== 'green') return { ...base, reason: `waiting gate: quick ${gates.quick}, api ${gates.full}` };

  if (freeze.verdict === 'needs-fixes' || freeze.verdict === 'reject') {
    return { ...base, reason: `reviewer @${freeze.reviewer_name ?? '?'} said ${freeze.verdict === 'reject' ? 'REJECT' : 'NEEDS FIXES'}; fix, push and freeze a new SHA` };
  }
  const verdicts = listVerdicts(freeze.sha);
  let verdictFiles = verdicts.filter((v) => v.verdict === 'pass').map((v) => v.path).filter((p): p is string => !!p);
  if (tier === 'ask') {
    const asked = askVerdicts(verdicts, { id: freeze.author_agent_id, name: freeze.author_name });
    if (!asked.ok) return { ...base, reason: `${asked.why}${forced ? ` — ask because of ${forced}` : ''}` };
    verdictFiles = asked.passes.map((p) => p.path).filter((p): p is string => !!p);
  }

  let pr: string | null = null;
  if (cfg.require_pr !== false) {
    pr = await findPr(repo, spec.remote, freeze.sha, freeze.lane, cfg);
    if (!pr) return { ...base, reason: `no pull request for ${freeze.lane} at ${freeze.sha.slice(0, 8)}` };
  }

  const migration = await migrationProblem(repo, mainRef, freeze.sha, migrationsDir);
  if (migration) return { ...base, state: 'bounced', reason: migration, pr, verdictFiles };

  return { ...base, state: 'queued', pr, verdictFiles };
}

// --- notes and audit -----------------------------------------------------------

function cetStamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Ljubljana', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `${parts} CET`;
}

function maestroLine(project: string, text: string): void {
  const file = mqConfig(project)?.maestro_log;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${cetStamp()} ${text}\n`);
  } catch (e) {
    logger.warn({ project, file, error: (e as Error).message }, 'Merge queue: maestro log not written');
  }
}

function tell(agentId: string | null, text: string): void {
  if (!agentId) return;
  const agent = getAgent(agentId);
  if (!agent.ok) return;
  void deliverSystemLine(agent.data, text, { kind: 'info', source: 'merge-queue' });
}

function authorFor(freeze: ReleaseFreeze): Agent | null {
  if (freeze.author_agent_id) {
    const a = getAgent(freeze.author_agent_id);
    if (a.ok) return a.data;
  }
  if (freeze.author_name) {
    const name = freeze.author_name.toLowerCase();
    return listAgents().find((a) => a.name.toLowerCase() === name || (a.alias ?? '').toLowerCase() === name) ?? null;
  }
  return null;
}

function bounce(freeze: ReleaseFreeze, row: MergeQueueRow, reason: string): void {
  const sha8 = freeze.sha.slice(0, 8);
  upsert({ sha: freeze.sha, project: row.project, lane: row.lane, state: 'bounced', reason, finished_at: new Date().toISOString() });
  emit(MERGE_QUEUE_EVENT.bounced, 'run', freeze.sha, { sha: freeze.sha, project: row.project, lane: row.lane, tier: row.tier, pr: row.pr, reason, at: cetStamp() }, null);
  tell(authorFor(freeze)?.id ?? null, `[from WaveCode] merge queue bounced ${sha8} on ${row.lane}: ${reason}. Fix it, push, and freeze a new SHA; the queue picks it up again.`);
  maestroLine(row.project, `bounced ${row.lane} ${sha8}: ${reason}`);
  logger.info({ sha: freeze.sha, lane: row.lane, reason }, 'Merge queue: bounced');
}

function requeue(freeze: ReleaseFreeze, row: MergeQueueRow, reason: string): void {
  upsert({ sha: freeze.sha, project: row.project, lane: row.lane, state: 'queued', reason, attempts: row.attempts + 1, started_at: null });
  emit(MERGE_QUEUE_EVENT.requeued, 'run', freeze.sha, { sha: freeze.sha, project: row.project, lane: row.lane, reason, attempts: row.attempts + 1 }, null);
}

// --- the merge job -------------------------------------------------------------

const MAX_ATTEMPTS = 3;

async function dropWorktree(repo: string, dir: string): Promise<void> {
  await tryGit(repo, ['worktree', 'remove', '--force', dir]);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  await tryGit(repo, ['worktree', 'prune']);
}

async function runMerge(row: MergeQueueRow): Promise<void> {
  const freeze = getFreeze(row.sha);
  const cfg = mqConfig(row.project);
  const repo = projectRepo(row.project);
  if (!freeze || !cfg || !repo) return;
  const spec = mainSpec(row.project);
  const sha8 = row.sha.slice(0, 8);
  const author = authorFor(freeze);
  const started = upsert({ sha: row.sha, project: row.project, lane: row.lane, state: 'merging', reason: null, started_at: new Date().toISOString(), enabled_by: kvGet(`merge_queue.${row.project}.by`) });

  const fetched = await tryGit(repo, ['fetch', '--quiet', spec.remote, spec.branch, row.lane], 90000);
  if (fetched === null) { requeue(freeze, started, `fetch from ${spec.remote} failed`); return; }
  const tip = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${spec.remote}/${row.lane}^{commit}`]);
  if (!tip || tip.toLowerCase() !== row.sha.toLowerCase()) {
    upsert({ sha: row.sha, project: row.project, lane: row.lane, state: 'waiting', reason: `lane moved to ${(tip ?? '').slice(0, 8) || 'nothing'} after the freeze; freeze that SHA`, started_at: null });
    return;
  }
  const mainBefore = await tryGit(repo, ['rev-parse', `refs/remotes/${spec.remote}/${spec.branch}^{commit}`]);
  if (!mainBefore) { requeue(freeze, started, `${spec.ref} not found after fetch`); return; }

  const dir = path.join(path.dirname(repo), '.wavecode-merges', `${path.basename(repo)}-${row.sha.slice(0, 9)}`);
  if (fs.existsSync(dir)) await dropWorktree(repo, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const added = await tryGit(repo, ['worktree', 'add', '--detach', dir, mainBefore]);
  if (added === null) { requeue(freeze, started, 'could not create the merge checkout'); return; }

  try {
    const message = [
      `Merge ${row.lane} (${sha8}) into ${spec.branch}`,
      '',
      `WaveCode merge queue · tier ${row.tier ?? '?'}${row.pr ? ` · PR ${row.pr}` : ''}`,
      `Lane SHA: ${row.sha}`,
      author ? `Author: @${author.alias ?? author.name}` : null,
    ].filter((l): l is string => l !== null).join('\n');
    const merged = await tryGit(dir, ['merge', '--no-ff', '--no-edit', '-m', message, row.sha], 120000);
    if (merged === null) {
      const files = (await tryGit(dir, ['diff', '--name-only', '--diff-filter=U']))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
      await tryGit(dir, ['merge', '--abort']);
      bounce(freeze, started, `merge conflict with ${spec.branch} in ${files.length ? files.join(', ') : 'unknown files'}; merge ${spec.ref} into your lane, run the quick check, and freeze the new SHA`);
      return;
    }

    if (cfg.version_command?.length) {
      const bumped = await runArgv(fill(cfg.version_command, { checkout: dir, sha: row.sha, lane: row.lane, project: row.project, remote: spec.remote }), { cwd: dir, timeoutMs: 120000 });
      if (bumped.code !== 0) { requeue(freeze, started, `version command failed (exit ${bumped.code})`); return; }
      const dirty = await tryGit(dir, ['status', '--porcelain']);
      if (dirty) {
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '--quiet', '--amend', '--no-edit']);
      }
    }

    const mergeSha = await git(dir, ['rev-parse', 'HEAD']);
    // The full suite runs once, here, on the merged code — even when the lane already
    // contained main. The freeze-time run only covered the quick suite and the changed parts.
    let gateNote: string;
    {
      const gateCmd = cfg.gate_command ?? getConfig().projects?.[row.project]?.pipeline?.gate_command ?? null;
      if (!gateCmd?.length) { bounce(freeze, started, 'no gate_command configured; the merge result cannot be tested'); return; }
      const minutes = cfg.gate_timeout_min ?? getConfig().projects?.[row.project]?.pipeline?.gate_timeout_min ?? 120;
      const env: Record<string, string> = {
        WAVECODE_SHA: mergeSha, WAVECODE_LANE: row.lane, WAVECODE_CHECKOUT: dir, WAVECODE_MERGE_OF: row.sha,
        WAVECODE_AUTHOR: author?.name ?? '', COUNTIX_REMOTE_TEST_WHO: author?.name ?? 'wavecode',
      };
      const result = await runArgv(fill(gateCmd, { checkout: dir, sha: mergeSha, lane: row.lane, project: row.project, remote: spec.remote }), { cwd: dir, env, timeoutMs: minutes * 60_000 });
      const word = gateOutcome(result);
      if (word === 'RED') {
        const last = result.stdout.trim().split('\n').filter((l) => l.trim()).slice(-1)[0] ?? '';
        bounce(freeze, started, `gate RED on merge ${mergeSha.slice(0, 8)}${last ? ` — ${last.slice(0, 160)}` : ''}`);
        return;
      }
      if (word !== 'GREEN') {
        if (started.attempts + 1 >= MAX_ATTEMPTS) { bounce(freeze, started, `gate stayed ${word} on merge ${mergeSha.slice(0, 8)} after ${MAX_ATTEMPTS} tries`); return; }
        requeue(freeze, started, `gate ${word} on merge ${mergeSha.slice(0, 8)}; trying again`);
        return;
      }
      gateNote = `gate GREEN on ${mergeSha.slice(0, 8)}`;
    }

    if (!queueEnabled(row.project)) { requeue(freeze, started, 'merge queue switched off before the push'); return; }

    // Plain push: never force, never a different ref. A rejected push means main moved; merge again.
    try {
      await git(dir, ['push', '--quiet', spec.remote, `HEAD:refs/heads/${spec.branch}`], 120000);
    } catch (e) {
      const text = (e as Error).message ?? '';
      if (/rejected|non-fast-forward|fetch first|stale info/i.test(text)) { requeue(freeze, started, `${spec.branch} moved during the gate; merging again`); return; }
      if (started.attempts + 1 >= MAX_ATTEMPTS) { bounce(freeze, started, `push to ${spec.branch} failed ${MAX_ATTEMPTS} times`); return; }
      requeue(freeze, started, `push to ${spec.branch} failed; trying again`);
      return;
    }

    let gateRuns: string[] = [];
    if (testsConfigured(row.project)) {
      try { gateRuns = (await readLaneTests(row.project, row.lane, mergeSha)).map((r) => r.id).filter((id) => id && !id.startsWith('queued-')); } catch { gateRuns = []; }
    }
    const verdictFiles = (row.verdict_files ?? '').split('\n').filter(Boolean);
    const payload = {
      project: row.project, lane: row.lane, tier: row.tier, pr: row.pr,
      sha_in: row.sha, sha_out: mergeSha, main_before: mainBefore,
      gate: gateNote, gate_runs: gateRuns, verdict_files: verdictFiles,
      enabled_by: started.enabled_by, author: author?.name ?? freeze.author_name, at: cetStamp(),
    };
    upsert({ sha: row.sha, project: row.project, lane: row.lane, state: 'merged', reason: gateNote, merge_sha: mergeSha, gate_runs: gateRuns.join(','), finished_at: new Date().toISOString() });
    emit(MERGE_QUEUE_EVENT.merged, 'run', row.sha, payload, null);
    tell(author?.id ?? null, `[from WaveCode] merged ${row.lane} ${sha8} into ${spec.branch} as ${mergeSha.slice(0, 8)}${row.pr ? ` (PR ${row.pr})` : ''}. ${gateNote}. Nothing else to do on this lane.`);
    maestroLine(row.project, `merged ${row.lane} ${sha8} -> ${spec.branch} ${mergeSha.slice(0, 8)} (tier ${row.tier ?? '?'}${row.pr ? `, PR ${row.pr}` : ''}${gateRuns.length ? `, gate ${gateRuns.join(' ')}` : ''}${verdictFiles.length ? `, verdicts ${verdictFiles.map((f) => path.basename(f)).join(' ')}` : ''})`);
    logger.info({ sha: row.sha, lane: row.lane, mergeSha }, 'Merge queue: merged');
    await tryGit(repo, ['fetch', '--quiet', spec.remote, spec.branch], 60000);
    await fireMainAdvanced(row.project, mergeSha);
  } finally {
    await dropWorktree(repo, dir);
  }
}

// --- the tick ------------------------------------------------------------------

function recoverOnce(): void {
  if (recovered) return;
  recovered = true;
  withTable(() => {
    getDb().prepare("UPDATE merge_queue SET state = 'queued', reason = 'daemon restarted during the merge; starting over', started_at = NULL, updated_at = datetime('now') WHERE state = 'merging'").run();
  });
}

async function refreshProject(project: string): Promise<MergeQueueRow | null> {
  const open = listFreezes().filter((f) => f.project === project && f.lane && (f.status === 'open' || f.status === 'behind-main'));
  const openShas = new Set(open.map((f) => f.sha));
  for (const row of listQueue(project)) {
    if ((row.state === 'waiting' || row.state === 'queued') && !openShas.has(row.sha)) {
      const freeze = getFreeze(row.sha);
      upsert({ sha: row.sha, project, lane: row.lane, state: 'superseded', reason: `freeze ${freeze?.status ?? 'gone'}`, finished_at: new Date().toISOString() });
    }
  }
  for (const freeze of open) {
    const existing = getQueueRow(freeze.sha);
    if (existing && (existing.state === 'merged' || existing.state === 'bounced' || existing.state === 'merging')) continue;
    let result: Eligibility;
    try { result = await evaluate(freeze); } catch (e) {
      result = { state: 'waiting', reason: `check failed: ${(e as Error).message}`.slice(0, 200), tier: null, pr: null, verdictFiles: [] };
    }
    const lane = freeze.lane!;
    if (result.state === 'bounced') {
      const row = upsert({ sha: freeze.sha, project, lane, tier: result.tier, pr: result.pr, verdict_files: result.verdictFiles.join('\n') });
      bounce(freeze, row, result.reason ?? 'not eligible');
      continue;
    }
    const wasQueued = existing?.state === 'queued';
    if (result.state === 'queued' && !queueEnabled(project)) result.reason = 'merge queue is off';
    upsert({
      sha: freeze.sha, project, lane, tier: result.tier, state: result.state, reason: result.reason, pr: result.pr,
      verdict_files: result.verdictFiles.join('\n'),
      eligible_at: result.state === 'queued' ? (existing?.eligible_at ?? new Date().toISOString()) : null,
    });
    if (result.state === 'queued' && !wasQueued) {
      emit(MERGE_QUEUE_EVENT.queued, 'run', freeze.sha, { sha: freeze.sha, project, lane, tier: result.tier, pr: result.pr }, null);
      tell(authorFor(freeze)?.id ?? null, `[from WaveCode] ${freeze.sha.slice(0, 8)} on ${lane} is in the merge queue (tier ${result.tier}); it merges into main when its turn comes. Nothing to do.`);
    }
  }
  const queued = listQueue(project).filter((r) => r.state === 'queued');
  return queued[0] ?? null;
}

/**
 * One pass: refresh every open freeze's eligibility and start the head of the
 * queue when nothing is merging for that project. The merge itself runs in the
 * background (a gate takes as long as the remote suite); `wait` awaits it.
 */
export async function mergeQueueTick(opts: { wait?: boolean } = {}): Promise<void> {
  recoverOnce();
  for (const project of configuredProjects()) {
    if (inflight.has(project)) { if (opts.wait) await inflight.get(project); continue; }
    let head: MergeQueueRow | null = null;
    try { head = await refreshProject(project); } catch (e) {
      logger.warn({ project, error: (e as Error).message }, 'Merge queue: refresh failed');
    }
    if (!queueEnabled(project)) {
      // The switch is off: the cards still show who is eligible, nothing is merged.
      for (const row of listQueue(project)) {
        if (row.state === 'queued') upsert({ sha: row.sha, project, lane: row.lane, reason: 'merge queue is off' });
      }
      continue;
    }
    if (!head) continue;
    const job = runMerge(head)
      .catch((e) => logger.warn({ project, sha: head!.sha, error: (e as Error).message }, 'Merge queue: job failed'))
      .finally(() => inflight.delete(project));
    inflight.set(project, job);
    if (opts.wait) await job;
  }
}

export function resetMergeQueueForTest(): void {
  inflight.clear();
  recovered = false;
  execForTest = null;
}
