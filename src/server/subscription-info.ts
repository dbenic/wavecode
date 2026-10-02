/**
 * Which subscription an agent is burning (multi-orchestrator spec §5):
 * the account label and the plan tier of the CLI login an agent runs on,
 * so the header can say "denis@… · Claude Max" instead of just "profile: denis".
 *
 * Reads credential stores ONLY for two non-secret fields — an account label
 * (email) and a plan name — and returns nothing else. Tokens are never kept,
 * logged or exposed; a file that is missing, unreadable, too big or not the
 * expected shape yields nulls. Results are cached per file mtime.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, type WaveConfig } from './config.js';
import { resolveProfileEnv } from './profiles.js';

export interface SubscriptionInfo {
  /** Account label (login email) or null when unknown. */
  account: string | null;
  /** Human plan name ("Claude Max", "ChatGPT Plus") or null when unknown. */
  plan: string | null;
}

const EMPTY: SubscriptionInfo = { account: null, plan: null };
const MAX_FILE_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;

/** Parsed JSON by path, invalidated when the file's mtime changes. */
const cache = new Map<string, { mtimeMs: number; json: Json | null }>();

function readJsonCached(file: string): Json | null {
  let mtimeMs: number;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.json;
  let json: Json | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    json = null;
  }
  cache.set(file, { mtimeMs, json });
  return json;
}

/** Test hook. */
export function clearSubscriptionCache(): void {
  cache.clear();
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

/** Decode a JWT payload without verifying it — the claims we take are display-only. */
function jwtClaims(token: unknown): Json | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return obj(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

const CLAUDE_PLANS: Record<string, string> = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };
const CHATGPT_PLANS: Record<string, string> = { free: 'ChatGPT Free', plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', team: 'ChatGPT Team', business: 'ChatGPT Business', enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu' };

function label(raw: string | null, table: Record<string, string>, vendor: string): string | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  return table[key] ?? `${vendor} ${raw}`;
}

/**
 * Env the runtime would be launched with on this profile (empty = home-dir
 * login). An unresolvable profile is `null`: never fall back to the home
 * login, which would attribute the wrong subscription.
 */
function runtimeEnv(runtime: string, profile: string | null, cfg: WaveConfig): Record<string, string> | null {
  if (!profile) return {};
  const env = resolveProfileEnv(runtime, profile, cfg);
  return env.ok ? env.data : null;
}

function claudeInfo(env: Record<string, string>): SubscriptionInfo {
  // Logins live under CLAUDE_CONFIG_DIR (default ~/.claude); the account
  // record sits next to it in ~/.claude.json unless the dir is overridden.
  const configDir = env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  const accountFile = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR
    ? path.join(configDir, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  const credentials = readJsonCached(path.join(configDir, '.credentials.json'));
  const account = readJsonCached(accountFile);
  const oauth = obj(credentials?.claudeAiOauth);
  const who = obj(account?.oauthAccount);
  return {
    account: str(who?.emailAddress),
    plan: label(str(oauth?.subscriptionType), CLAUDE_PLANS, 'Claude'),
  };
}

function codexInfo(env: Record<string, string>): SubscriptionInfo {
  const home = env.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const auth = readJsonCached(path.join(home, 'auth.json'));
  if (!auth) return EMPTY;
  const tokens = obj(auth.tokens);
  const claims = jwtClaims(tokens?.id_token);
  if (!claims) return str(auth.OPENAI_API_KEY) ? { account: null, plan: 'OpenAI API key' } : EMPTY;
  const authClaims = obj(claims['https://api.openai.com/auth']);
  return {
    account: str(claims.email),
    plan: label(str(authClaims?.chatgpt_plan_type), CHATGPT_PLANS, 'ChatGPT'),
  };
}

function grokInfo(env: Record<string, string>): SubscriptionInfo {
  const home = env.HOME ?? os.homedir();
  const dir = path.join(home, '.grok');
  // Field names are not documented; take the obvious ones and nothing else.
  for (const file of ['user-settings.json', 'auth.json']) {
    const json = readJsonCached(path.join(dir, file));
    if (!json) continue;
    const user = obj(json.user) ?? json;
    const account = str(user.email) ?? str(json.email);
    const plan = str(json.plan) ?? str(json.tier) ?? str(json.subscription) ?? str(user.plan);
    if (account || plan) return { account, plan: plan ? label(plan, {}, 'Grok') : null };
  }
  return EMPTY;
}

/**
 * Subscription an agent of `runtime` runs on: its profile's login, or the
 * service user's home-dir login when it has no profile.
 */
export function subscriptionFor(runtime: string, profile: string | null | undefined, cfg?: WaveConfig): SubscriptionInfo {
  try {
    // Resolved inside the try: with no config loaded (embedded / test apps) the answer is simply "unknown".
    const env = runtimeEnv(runtime, profile ?? null, cfg ?? getConfig());
    if (!env) return EMPTY;
    switch (runtime) {
      case 'claude-code': return claudeInfo(env);
      case 'codex': return codexInfo(env);
      case 'grok': return grokInfo(env);
      default: return EMPTY;
    }
  } catch {
    return EMPTY;
  }
}
