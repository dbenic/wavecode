/**
 * Seat credentials (1 Nov 2026 policy: no seat uses any API key; a seat whose
 * login is gone, or whose plan is under the floor, comes out of rotation and
 * the UI says why).
 *
 * Every `usage.probe_interval_min` (default 15) and shortly after a spawn,
 * WaveCode reads — without typing into any pane — how each seat is
 * authenticated:
 *   - Claude Code: `$CLAUDE_CONFIG_DIR/.credentials.json` (an OAuth login, its
 *     plan) and `.claude.json` (whether the profile approved or rejected a
 *     custom API key);
 *   - Codex: `$CODEX_HOME/auth.json` (ChatGPT tokens vs an OpenAI API key);
 *   - any subscription CLI (one with a `login_command`): its credential files,
 *     and the environment of the process running in its pane for a provider
 *     key (provider-keys.ts). Only a key the CLI itself bills counts as
 *     `api-key` (xAI for grok); a stale foreign key (the daemon's Anthropic key
 *     inherited by a Kimi pane before the 1 Nov 2026 scrub) is `env_key` on
 *     a logged-in seat, never a reason to park.
 * Only field presence, plan names and variable NAMES leave this module; a
 * key value is compared in memory against the CLI's own rejected/approved
 * list and never stored, logged or emitted.
 *
 * Modes: `subscription` (fit), `logged-out` (parked: wait reason `login`),
 * `api-key` (the pane is killed once, the seat is parked: wait reason `key`),
 * `unknown` (a key-based runtime such as aider, or nothing readable; never
 * parked). A provider key that sits in the pane environment but that the CLI
 * has rejected is `subscription` with `env_key` set: the UI shows it, a
 * pane restart clears it, nothing is parked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, type WaveConfig } from './config.js';
import { getDb, listAgents, updateAgentStatus, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { notify } from './notifications.js';
import { execFileAsync } from './proc.js';
import { resolveProfileEnv } from './profiles.js';
import { PROVIDER_KEY_VARS, type ProviderKeyVar } from './provider-keys.js';
import { subscriptionFor } from './subscription-info.js';
import * as tmux from './tmux.js';
import { quotaLeftPct } from './usage-probe.js';

export type AuthMode = 'subscription' | 'api-key' | 'logged-out' | 'unknown';

export interface SeatAuth {
  mode: AuthMode;
  /** Plan label ("Claude Max", "ChatGPT Pro") when known. */
  plan: string | null;
  /** One line for the UI: what was found. Never a secret. */
  detail: string | null;
  /** A provider key NAME found in the pane environment that the CLI rejected (clean on restart). */
  env_key: string | null;
  checked_at: string;
}

export type OutReason = 'key' | 'login' | 'quota';

/** Why a seat is out of rotation, for the dispatcher and the UI. */
export interface SeatOut {
  reason: OutReason;
  detail: string;
  /** ISO time of the probe or reading that put it out. */
  since: string | null;
}

/** Plan floor (percent left of the 5-hour or weekly window) under which a seat is parked. */
export const DEFAULT_MIN_QUOTA_PCT = 5;

/** Readers, injectable for tests. */
export interface SeatAuthDeps {
  readJson(file: string): Record<string, unknown> | null;
  fileExists(file: string): boolean;
  /** Environment of the process running in the pane (null = not readable here). */
  paneEnv(agent: Pick<Agent, 'tmux_session'>): Promise<Record<string, string> | null>;
  now(): Date;
}

const MAX_FILE_BYTES = 1024 * 1024;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fileExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/**
 * Environment of the runtime process in the pane: the pane's shell pid from
 * tmux, its children from pgrep, their `/proc/<pid>/environ`. Linux only;
 * anywhere else (or a bare shell with no child) → null.
 */
async function paneEnv(agent: Pick<Agent, 'tmux_session'>): Promise<Record<string, string> | null> {
  if (process.platform !== 'linux') return null;
  const panePid = await tmux.panePid(agent.tmux_session);
  if (!panePid) return null;
  let children: number[] = [];
  try {
    const out = await execFileAsync('pgrep', ['-P', String(panePid)], { timeout: 3000 });
    children = out.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return null; // pgrep exits 1 with no children: a bare shell
  }
  for (const pid of children) {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      const env: Record<string, string> = {};
      for (const entry of raw.split('\0')) {
        const i = entry.indexOf('=');
        if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
      }
      return env;
    } catch {
      continue;
    }
  }
  return null;
}

export const defaultDeps: SeatAuthDeps = { readJson, fileExists, paneEnv, now: () => new Date() };

export function ensureAgentAuthTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS agent_auth (
      agent_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      plan TEXT,
      detail TEXT,
      env_key TEXT,
      checked_at TEXT NOT NULL
    );
  `);
}

export function seatAuthFor(agentId: string): SeatAuth | null {
  try {
    const row = getDb().prepare('SELECT mode, plan, detail, env_key, checked_at FROM agent_auth WHERE agent_id = ?').get(agentId) as
      | { mode: AuthMode; plan: string | null; detail: string | null; env_key: string | null; checked_at: string }
      | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

const CLAUDE_PLANS: Record<string, string> = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };

function claudeAuth(env: Record<string, string>, pane: Record<string, string> | null, deps: SeatAuthDeps): Omit<SeatAuth, 'checked_at'> {
  const configDir = env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const accountFile = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR
    ? path.join(configDir, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  const oauth = obj(deps.readJson(path.join(configDir, '.credentials.json'))?.claudeAiOauth);
  const responses = obj(deps.readJson(accountFile)?.customApiKeyResponses);
  const approved = strList(responses?.approved);
  const rejected = strList(responses?.rejected);
  const planRaw = str(oauth?.subscriptionType);
  const plan = planRaw ? CLAUDE_PLANS[planRaw.toLowerCase()] ?? `Claude ${planRaw}` : null;

  if (approved.length) return { mode: 'api-key', plan, detail: 'the profile approved a custom API key (customApiKeyResponses.approved)', env_key: null };
  if (pane?.ANTHROPIC_AUTH_TOKEN) return { mode: 'api-key', plan, detail: 'ANTHROPIC_AUTH_TOKEN in the pane environment', env_key: 'ANTHROPIC_AUTH_TOKEN' };
  const key = pane?.ANTHROPIC_API_KEY;
  if (key) {
    const suffix = key.slice(-20); // Claude Code's own identifier for an answered key; compared in memory, never kept
    if (!oauth) return { mode: 'api-key', plan, detail: 'ANTHROPIC_API_KEY in the pane environment and no login on the profile', env_key: 'ANTHROPIC_API_KEY' };
    if (rejected.includes(suffix)) return { mode: 'subscription', plan, detail: 'ANTHROPIC_API_KEY sits in the pane environment; the CLI rejected it (a pane restart clears it)', env_key: 'ANTHROPIC_API_KEY' };
    return { mode: 'api-key', plan, detail: 'ANTHROPIC_API_KEY in the pane environment, not rejected by the CLI', env_key: 'ANTHROPIC_API_KEY' };
  }
  if (!oauth) return { mode: 'logged-out', plan: null, detail: 'no OAuth login in .credentials.json', env_key: null };
  return { mode: 'subscription', plan, detail: null, env_key: null };
}

function codexAuth(runtime: string, profile: string | null, env: Record<string, string>, pane: Record<string, string> | null, cfg: WaveConfig, deps: SeatAuthDeps): Omit<SeatAuth, 'checked_at'> {
  const home = env.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const auth = deps.readJson(path.join(home, 'auth.json'));
  const plan = subscriptionFor(runtime, profile, cfg).plan;
  if (pane?.OPENAI_API_KEY) return { mode: 'api-key', plan, detail: 'OPENAI_API_KEY in the pane environment (Codex bills it before the login)', env_key: 'OPENAI_API_KEY' };
  if (!auth) return { mode: 'logged-out', plan: null, detail: 'no auth.json on the profile', env_key: null };
  if (obj(auth.tokens)) return { mode: 'subscription', plan, detail: null, env_key: null };
  if (str(auth.OPENAI_API_KEY)) return { mode: 'api-key', plan: plan ?? 'OpenAI API key', detail: 'auth.json holds an OpenAI API key, no ChatGPT login', env_key: null };
  return { mode: 'logged-out', plan: null, detail: 'auth.json has no login tokens', env_key: null };
}

/** Which provider keys the pane environment carries, by name. */
function paneKeys(pane: Record<string, string> | null): ProviderKeyVar[] {
  if (!pane) return [];
  return PROVIDER_KEY_VARS.filter((v) => typeof pane[v] === 'string' && pane[v].length > 0);
}

/** The provider key variables a runtime's own CLI would bill, by runtime name (none known → none). */
export function ownKeyVars(runtime: string): ProviderKeyVar[] {
  const r = runtime.toLowerCase();
  if (r.includes('claude') || r.includes('anthropic')) return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  if (r.includes('codex') || r.includes('openai')) return ['OPENAI_API_KEY'];
  if (r.includes('gemini') || r.includes('google')) return ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  if (r.includes('grok') || r.includes('xai')) return ['XAI_API_KEY'];
  return [];
}

/**
 * How a seat is authenticated right now (pure apart from `deps`). Runtimes
 * without a `login_command` are key-based by design (aider) → `unknown`.
 */
export async function inspectSeatAuth(
  agent: Pick<Agent, 'runtime' | 'profile' | 'tmux_session'>,
  cfg: WaveConfig = getConfig(),
  deps: SeatAuthDeps = defaultDeps,
): Promise<SeatAuth> {
  const checked_at = deps.now().toISOString();
  const rc = cfg.runtimes[agent.runtime];
  if (!rc || !rc.login_command) return { mode: 'unknown', plan: null, detail: rc ? 'key-based runtime' : 'unknown runtime', env_key: null, checked_at };
  const resolved = resolveProfileEnv(agent.runtime, agent.profile ?? null, cfg);
  if (!resolved.ok) return { mode: 'unknown', plan: null, detail: resolved.error, env_key: null, checked_at };
  const env = resolved.data;
  const pane = await deps.paneEnv(agent);

  let found: Omit<SeatAuth, 'checked_at'>;
  switch (agent.runtime) {
    case 'claude-code':
      found = claudeAuth(env, pane, deps);
      break;
    case 'codex':
      found = codexAuth(agent.runtime, agent.profile ?? null, env, pane, cfg, deps);
      break;
    default: {
      // A subscription CLI we only know by its credential files (grok, kimi): logged in when one exists.
      // Only a key its own CLI would bill is a key in use; a foreign key in the pane (a Kimi pane that
      // inherited the daemon's Anthropic key) cannot be spent by this CLI: reported as env_key, not parked.
      const keys = paneKeys(pane);
      const own = ownKeyVars(agent.runtime);
      const billed = keys.find((k) => own.includes(k));
      if (billed) { found = { mode: 'api-key', plan: null, detail: `${billed} in the pane environment`, env_key: billed }; break; }
      const stray = keys[0] ?? null;
      const strayNote = stray ? `; ${stray} sits in the pane environment but this CLI cannot use it (a pane restart clears it)` : '';
      const dir = cfg.profiles_root && agent.profile ? path.join(cfg.profiles_root, agent.profile) : null;
      const files = (rc.credential_files ?? []).map((f) => (dir ? f.replaceAll('{profile_dir}', dir) : f));
      if (!files.length) { found = { mode: 'unknown', plan: null, detail: `no credential files configured${strayNote}`, env_key: stray }; break; }
      found = files.some((f) => deps.fileExists(f))
        ? { mode: 'subscription', plan: subscriptionFor(agent.runtime, agent.profile ?? null, cfg).plan, detail: stray ? strayNote.slice(2) : null, env_key: stray }
        : { mode: 'logged-out', plan: null, detail: `no credential file on the profile${strayNote}`, env_key: stray };
    }
  }
  return { ...found, checked_at };
}

// --- persistence, transitions, timer ---

const SOON_MS = 20_000;
const TICK_MS = 60_000;
const REMIND_MS = 3600_000;
let timer: ReturnType<typeof setInterval> | null = null;
/** agent id → epoch ms of the last `agent.logged_out` / `agent.api_key` reminder. */
const reminded = new Map<string, number>();

function store(agentId: string, auth: SeatAuth): void {
  getDb().prepare(`INSERT INTO agent_auth (agent_id, mode, plan, detail, env_key, checked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET mode = excluded.mode, plan = excluded.plan, detail = excluded.detail, env_key = excluded.env_key, checked_at = excluded.checked_at`)
    .run(agentId, auth.mode, auth.plan, auth.detail, auth.env_key, auth.checked_at);
}

export function forgetSeatAuth(agentId: string): void {
  try { getDb().prepare('DELETE FROM agent_auth WHERE agent_id = ?').run(agentId); } catch { /* table absent in embedded apps */ }
  reminded.delete(agentId);
}

/**
 * Re-read one seat, store the result, and act on a change: a key → the pane
 * is killed (spawned seats) and everyone is told; a lost login → told; a
 * return to a subscription → `agent.auth_restored`. While a seat stays out,
 * the event repeats once an hour (like `agent.quota_low`).
 */
export async function refreshSeatAuth(agent: Agent, deps: SeatAuthDeps = defaultDeps): Promise<SeatAuth> {
  const previous = seatAuthFor(agent.id);
  const auth = await inspectSeatAuth(agent, getConfig(), deps);
  store(agent.id, auth);
  const payload = { name: agent.name, mode: auth.mode, plan: auth.plan, detail: auth.detail, env_key: auth.env_key, previous: previous?.mode ?? null };
  const changed = previous?.mode !== auth.mode;
  const now = deps.now().getTime();
  const remind = !changed && (auth.mode === 'api-key' || auth.mode === 'logged-out') && now - (reminded.get(agent.id) ?? 0) > REMIND_MS;

  if (changed || remind) {
    reminded.set(agent.id, now);
    if (auth.mode === 'api-key') {
      emit('agent.api_key', 'agent', agent.id, payload, null);
      logger.warn({ agentId: agent.id, agent: agent.name, detail: auth.detail }, 'Seat runs on an API key: parked');
      if (changed && agent.mode === 'spawned') {
        // Take it out: the pane dies now; a relaunch starts clean (env -u …) and the next probe restores it.
        await tmux.killSession(agent.tmux_session);
        updateAgentStatus(agent.id, 'error');
        emit('agent.killed_for_key', 'agent', agent.id, payload, null);
      }
      if (changed) await notify({ title: `@${agent.alias ?? agent.name} used an API key`, body: `${auth.detail ?? 'provider key detected'} — the seat is out of rotation`, url: `/agent/${agent.id}`, tag: `api-key-${agent.id}` });
    } else if (auth.mode === 'logged-out') {
      emit('agent.logged_out', 'agent', agent.id, payload, null);
      logger.warn({ agentId: agent.id, agent: agent.name, detail: auth.detail }, 'Seat is logged out: parked');
      if (changed) await notify({ title: `@${agent.alias ?? agent.name} is logged out`, body: `${auth.detail ?? 'no login'} — the seat is out of rotation until the profile logs in`, url: `/agent/${agent.id}`, tag: `logged-out-${agent.id}` });
    } else if (changed && previous && (previous.mode === 'api-key' || previous.mode === 'logged-out')) {
      emit('agent.auth_restored', 'agent', agent.id, payload, null);
      reminded.delete(agent.id);
    } else if (changed) {
      emit('agent.auth_checked', 'agent', agent.id, payload, null);
    }
  }
  return auth;
}

/** Spawn/relaunch hook: the runtime needs a moment to start before its environment is readable. */
export function refreshSeatAuthSoon(agent: Agent): void {
  setTimeout(() => { void refreshSeatAuth(agent).catch((e) => logger.warn({ agentId: agent.id, error: (e as Error).message }, 'Seat auth probe failed')); }, SOON_MS).unref?.();
}

function due(agent: Agent, intervalMs: number, now: number): boolean {
  if (agent.mode === 'file' || agent.tmux_session.startsWith('wc-login-')) return false;
  const last = seatAuthFor(agent.id)?.checked_at;
  return !last || now - Date.parse(last) >= intervalMs;
}

export async function probeSeatAuthDue(now = Date.now()): Promise<void> {
  const minutes = getConfig().usage?.probe_interval_min ?? 15;
  if (!minutes || minutes <= 0) return;
  for (const agent of listAgents()) {
    if (!due(agent, minutes * 60_000, now)) continue;
    try {
      await refreshSeatAuth(agent);
    } catch (e) {
      logger.warn({ agentId: agent.id, error: (e as Error).message }, 'Seat auth probe failed');
    }
  }
}

export function startSeatAuthProbe(): void {
  if (timer) return;
  timer = setInterval(() => { void probeSeatAuthDue(); }, TICK_MS);
  setTimeout(() => { void probeSeatAuthDue(); }, 30_000).unref?.();
}

export function stopSeatAuthProbe(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resetSeatAuthForTest(): void {
  reminded.clear();
}

// --- the rule ---

/**
 * Why a seat is out of rotation: a key (never), no login, or a plan window
 * under the floor. Null = fit. Used by the dispatcher, the task route and the
 * boards, so every surface says the same thing.
 */
export function seatOut(agent: Pick<Agent, 'id' | 'runtime' | 'profile'>, cfg: WaveConfig = getConfig()): SeatOut | null {
  const auth = seatAuthFor(agent.id);
  if (auth?.mode === 'api-key') return { reason: 'key', detail: auth.detail ?? 'runs on an API key', since: auth.checked_at };
  if (auth?.mode === 'logged-out') return { reason: 'login', detail: auth.detail ?? 'logged out', since: auth.checked_at };
  const floor = cfg.autonomy?.min_quota_pct ?? DEFAULT_MIN_QUOTA_PCT;
  const left = quotaLeftPct(agent.runtime, agent.profile);
  if (left !== null && left < floor) return { reason: 'quota', detail: `${left}% of the plan left (floor ${floor}%)`, since: null };
  return null;
}
