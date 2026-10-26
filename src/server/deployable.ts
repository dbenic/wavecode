/**
 * "Main is the only road to prod" (Denis, 26 Oct 2026). One check for every deploy request,
 * the Stage/Promote buttons, SystemOps' deploy guard (`wavecode deployable <sha>`) and the
 * Reviews page: a SHA may go to production only when it
 *
 *   1. is on origin/main (an ancestor of main or main itself),
 *   2. contains the SHA production runs now (forward-only: no rollback, no branch cut from prod),
 *   3. has quick and api GREEN on that exact SHA (the one checker, docs/merge-queue.md).
 *
 * What production runs is recorded here (`wavecode prod-sha <sha>` or `POST /api/deployable/prod-sha`,
 * admin) and falls back to the newest deployed production release WaveCode knows. Prod drift
 * (production on a SHA that is not on main) is reported by `prodDrift` and shown as a red banner.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from './db.js';
import { emit } from './event-bus.js';
import { checkGateStatus, wavecodeBuild, type GateState, type GateStatusReport } from './gate-status.js';
import { mainSpec, projectRepo, resolveMainRef } from './lane-main.js';
import logger from './logger.js';

const execFileAsync = promisify(execFile);
const SHA_RE = /^[0-9a-f]{40}$/i;

export interface DeployableCheck { ok: boolean; text: string }

export interface DeployableReport {
  schema_version: 1;
  project: string;
  sha: string;
  deployable: boolean;
  /** 0 deployable, 2 not deployable, 1 the check itself failed (unknown SHA, no repo). */
  exit_code: 0 | 1 | 2;
  main_sha: string | null;
  prod_sha: string | null;
  checks: { on_main: DeployableCheck; contains_prod: DeployableCheck; quick: DeployableCheck; api: DeployableCheck };
  reasons: string[];
  gates: GateStatusReport | null;
  checked_at: string;
  wavecode_build: string;
}

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const out = await execFileAsync('git', ['-C', repo, ...args], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    return out.stdout.trim();
  } catch {
    return null;
  }
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

const PROD_SHA_EVENT = 'prod.sha';

/** The SHA production runs now: the recorded one, else the newest deployed production release. */
export function productionSha(project: string): { sha: string; source: 'recorded' | 'release'; by: string | null; at: string | null } | null {
  const raw = kvGet(`production_sha:${project}`);
  if (raw) {
    try {
      const rec = JSON.parse(raw) as { sha: string; by?: string | null; at?: string | null };
      if (SHA_RE.test(rec.sha)) return { sha: rec.sha.toLowerCase(), source: 'recorded', by: rec.by ?? null, at: rec.at ?? null };
    } catch { /* fall through */ }
  }
  try {
    const row = getDb().prepare(
      `SELECT sha, deployed_sha, created_at FROM release_requests WHERE target = 'production' AND status = 'deployed' AND (project = ? OR project IS NULL) ORDER BY created_at DESC LIMIT 1`,
    ).get(project) as { sha: string; deployed_sha: string | null; created_at: string } | undefined;
    const sha = (row?.deployed_sha || row?.sha || '').toLowerCase();
    if (SHA_RE.test(sha)) return { sha, source: 'release', by: null, at: row?.created_at ?? null };
  } catch { /* no release table */ }
  return null;
}

/** Record what production runs (SystemOps after a deploy, or Denis). */
export function setProductionSha(project: string, sha: string, by: string): { ok: true; sha: string } | { ok: false; error: string } {
  if (!SHA_RE.test(sha)) return { ok: false, error: 'sha must be the exact 40-character commit id' };
  const at = new Date().toISOString();
  kvSet(`production_sha:${project}`, JSON.stringify({ sha: sha.toLowerCase(), by, at }));
  emit(PROD_SHA_EVENT, 'project', project, { project, sha: sha.toLowerCase(), by, at }, null);
  return { ok: true, sha: sha.toLowerCase() };
}

function gateCheck(state: GateState | undefined, suite: string, sha8: string): DeployableCheck {
  const s = state ?? 'MISSING';
  if (s === 'GREEN') return { ok: true, text: `${suite} GREEN on ${sha8}` };
  if (s === 'RED') return { ok: false, text: `${suite} RED on ${sha8}: fix and get a GREEN on this exact SHA` };
  if (s === 'RUNNING') return { ok: false, text: `${suite} still running on ${sha8}: wait for the result` };
  if (s === 'ERROR') return { ok: false, text: `${suite} did not run on ${sha8} (tool error): run it again` };
  return { ok: false, text: `${suite} has no result on ${sha8}: run countix-remote-test --suite ${suite === 'quick' ? 'tier1' : 'api'} on it` };
}

export async function checkDeployable(project: string, sha: string): Promise<DeployableReport> {
  const checked_at = new Date().toISOString();
  const sha8 = sha.slice(0, 8);
  const failed = (text: string, exit: 1 | 2 = 1): DeployableReport => ({
    schema_version: 1, project, sha, deployable: false, exit_code: exit, main_sha: null, prod_sha: null,
    checks: { on_main: { ok: false, text }, contains_prod: { ok: false, text: 'not checked' }, quick: { ok: false, text: 'not checked' }, api: { ok: false, text: 'not checked' } },
    reasons: [text], gates: null, checked_at, wavecode_build: wavecodeBuild(),
  });
  if (!SHA_RE.test(sha)) return failed('sha must be the exact 40-character commit id');
  const repo = projectRepo(project);
  if (!repo) return failed(`project ${project} has no repo configured`);
  const spec = mainSpec(project);
  await git(repo, ['fetch', '--quiet', spec.remote, spec.branch]);
  const mainRef = await resolveMainRef(repo, project);
  if (!mainRef) return failed(`${spec.ref} not found in ${repo}`);
  const mainSha = (await git(repo, ['rev-parse', `${mainRef}^{commit}`]))?.toLowerCase() ?? null;
  if ((await git(repo, ['cat-file', '-e', `${sha}^{commit}`])) === null) return failed(`${sha8} is not a commit in ${repo} (not fetched, or never pushed)`);

  const onMain = (await git(repo, ['merge-base', '--is-ancestor', sha, mainRef])) !== null;
  const on_main: DeployableCheck = onMain
    ? { ok: true, text: sha.toLowerCase() === mainSha ? `${sha8} is ${spec.ref}` : `${sha8} is on ${spec.ref} (main is ${(mainSha ?? '').slice(0, 8)})` }
    : { ok: false, text: `${sha8} is not on ${spec.ref}: merge it through the queue first; prod deploys only from main` };

  const prod = productionSha(project);
  let contains_prod: DeployableCheck;
  if (!prod) {
    contains_prod = { ok: false, text: 'what production runs is not recorded: SystemOps records it with wavecode prod-sha <sha> after each deploy' };
  } else if (prod.sha === sha.toLowerCase()) {
    contains_prod = { ok: true, text: `${sha8} is what production runs now (${prod.source})` };
  } else if ((await git(repo, ['cat-file', '-e', `${prod.sha}^{commit}`])) === null) {
    contains_prod = { ok: false, text: `production runs ${prod.sha.slice(0, 8)} and that commit is not in ${repo}: fetch it, or record the right SHA with wavecode prod-sha` };
  } else if ((await git(repo, ['merge-base', '--is-ancestor', prod.sha, sha])) !== null) {
    contains_prod = { ok: true, text: `${sha8} contains production's ${prod.sha.slice(0, 8)} (forward-only)` };
  } else {
    contains_prod = { ok: false, text: `${sha8} does not contain production's ${prod.sha.slice(0, 8)}: no rollback and no branch cut from prod; main must first contain what prod runs` };
  }

  let gates: GateStatusReport | null = null;
  try {
    gates = await checkGateStatus(project, sha, ['quick', 'api']);
  } catch (e) {
    logger.debug({ project, sha, error: (e as Error).message }, 'deployable: gate check failed');
  }
  const quick = gateCheck(gates?.suites.quick?.state, 'quick', sha8);
  const api = gateCheck(gates?.suites.api?.state, 'api', sha8);
  const checks = { on_main, contains_prod, quick, api };
  const reasons = Object.values(checks).filter((c) => !c.ok).map((c) => c.text);
  const deployable = reasons.length === 0;
  return {
    schema_version: 1, project, sha: sha.toLowerCase(), deployable, exit_code: deployable ? 0 : 2, main_sha: mainSha, prod_sha: prod?.sha ?? null,
    checks, reasons, gates, checked_at, wavecode_build: wavecodeBuild(),
  };
}

export function formatDeployable(r: DeployableReport): string {
  const lines = [`${r.deployable ? 'YES' : 'NO'} ${r.sha.slice(0, 8)} deployable to production${r.main_sha ? ` (main ${r.main_sha.slice(0, 8)}${r.prod_sha ? `, prod ${r.prod_sha.slice(0, 8)}` : ''})` : ''}`];
  for (const [name, c] of Object.entries(r.checks)) lines.push(`  ${c.ok ? 'ok ' : 'NO '} ${name.padEnd(13)} ${c.text}`);
  return lines.join('\n');
}

export interface ProdDrift { project: string; prod_sha: string; main_sha: string | null; text: string }

/** Production on a SHA that is not on main. Null when prod is unknown or on main. */
export async function prodDrift(project: string): Promise<ProdDrift | null> {
  const prod = productionSha(project);
  const repo = projectRepo(project);
  if (!prod || !repo) return null;
  const mainRef = await resolveMainRef(repo, project);
  if (!mainRef) return null;
  const mainSha = (await git(repo, ['rev-parse', `${mainRef}^{commit}`]))?.toLowerCase() ?? null;
  if ((await git(repo, ['cat-file', '-e', `${prod.sha}^{commit}`])) === null) {
    return { project, prod_sha: prod.sha, main_sha: mainSha, text: `production runs ${prod.sha.slice(0, 8)}, which is not in the WaveCode repo: fetch it or record the right SHA` };
  }
  if ((await git(repo, ['merge-base', '--is-ancestor', prod.sha, mainRef])) !== null) return null;
  return {
    project, prod_sha: prod.sha, main_sha: mainSha,
    text: `production runs ${prod.sha.slice(0, 8)}, which is not on ${mainSpec(project).ref}: nothing is deployable until a sync lane (prod merged into main) is merged`,
  };
}
