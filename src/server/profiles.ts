/**
 * Credential profiles (multi-orchestrator spec §5): one subscription per
 * developer. Every CLI keeps its login under $HOME, so all agents of the
 * service user would share one subscription. A profile is a named
 * credential directory `<profiles_root>/<profile>/…` that a runtime process
 * is pointed at through per-runtime env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 * `HOME` for grok), injected as an `env K=V … <command>` prefix.
 *
 * Profiles separate subscriptions, not access (see the spec) — but the env
 * values reach a shell, so they are validated as strictly as model pins.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, type WaveConfig } from './config.js';
import { getUser, type Result, type User } from './db.js';
import { OWNER_USER, OWNER_USER_ID } from './users.js';
import {
  PROFILE_NAME_RE,
  isSafeEnvKey,
  isSafeEnvValue,
  isValidProfileName,
  validateProfilesConfig,
} from './profile-validation.js';

export { PROFILE_NAME_RE, isValidProfileName, isSafeEnvKey, isSafeEnvValue, validateProfilesConfig };

/** Profiles configured? (Empty `profiles:` = feature off, home-dir login for all.) */
export function profilesEnabled(cfg: WaveConfig = getConfig()): boolean {
  return Object.keys(cfg.profiles ?? {}).length > 0;
}

export function isProfileConfigured(name: string, cfg: WaveConfig = getConfig()): boolean {
  return Object.prototype.hasOwnProperty.call(cfg.profiles ?? {}, name);
}

export function isSharedProfile(name: string, cfg: WaveConfig = getConfig()): boolean {
  return !!cfg.profiles?.[name]?.shared;
}

export function profileDir(name: string, cfg: WaveConfig = getConfig()): string {
  return path.join(cfg.profiles_root, name);
}

/**
 * Env for running `runtime` on `profile`. `null` profile → `{}` (home-dir
 * login, today's behavior). Any unsafe or unresolved value is an error —
 * never silently dropped, because launching without it would burn the
 * wrong subscription.
 */
export function resolveProfileEnv(
  runtime: string,
  profile: string | null | undefined,
  cfg: WaveConfig = getConfig(),
): Result<Record<string, string>> {
  if (!profile) return { ok: true, data: {} };
  if (!isValidProfileName(profile)) return { ok: false, error: `Invalid profile name '${profile}'` };
  if (!isProfileConfigured(profile, cfg)) return { ok: false, error: `Profile '${profile}' is not configured` };
  const rc = cfg.runtimes[runtime];
  if (!rc) return { ok: false, error: `Unknown runtime '${runtime}'` };

  const dir = profileDir(profile, cfg);
  const env: Record<string, string> = {};
  for (const [key, template] of Object.entries(rc.env ?? {})) {
    if (!isSafeEnvKey(key)) return { ok: false, error: `Invalid env name '${key}' for runtime '${runtime}'` };
    const value = template.replaceAll('{profile_dir}', dir);
    if (/\{\w+\}/.test(value)) return { ok: false, error: `Unknown placeholder in ${runtime} env ${key}: ${template}` };
    if (!isSafeEnvValue(value)) return { ok: false, error: `Unsafe value for ${runtime} env ${key}` };
    env[key] = value;
  }
  return { ok: true, data: env };
}

/** Env variables whose value is a file, not a directory (only the parent is created). */
const FILE_VALUED_ENV = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG', 'KUBECONFIG', 'NPM_CONFIG_USERCONFIG']);

/** Create the profile dir and every env path inside it ("dirs are created on first login"). */
export function ensureProfileDirs(profile: string, env: Record<string, string>, cfg: WaveConfig = getConfig()): void {
  const dir = profileDir(profile, cfg);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [key, value] of Object.entries(env)) {
    if (value !== dir && !value.startsWith(`${dir}${path.sep}`)) continue;
    const target = FILE_VALUED_ENV.has(key) ? path.dirname(value) : value;
    if (fs.existsSync(target)) continue; // including a file already there (e.g. a seeded gitconfig)
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
}

export type ProfileErrorCode = 'forbidden' | 'invalid';
export type ProfileResult<T> = { ok: true; data: T } | { ok: false; error: string; code: ProfileErrorCode };

/**
 * Which profile a newly spawned agent runs on: the caller's own, unless an
 * admin names one explicitly (`null` = home-dir login). Shared profiles are
 * admin-only. With profiles not configured, everything stays on null.
 */
export function resolveSpawnProfile(
  user: Pick<User, 'role' | 'profile'>,
  requested: unknown,
  cfgOverride?: WaveConfig,
): ProfileResult<string | null> {
  const admin = user.role === 'admin';
  // No profile requested and none on the caller (e.g. the owner) → home-dir
  // login without touching config, as before profiles existed.
  if (requested === undefined && !user.profile) return { ok: true, data: null };
  const cfg = cfgOverride ?? getConfig();

  if (requested !== undefined) {
    if (requested !== null && !isValidProfileName(requested)) {
      return { ok: false, code: 'invalid', error: 'profile must be a profile name or null' };
    }
    if (!admin && requested !== (user.profile ?? null)) {
      return { ok: false, code: 'forbidden', error: 'Only admins may spawn on another profile' };
    }
    if (requested === null) return { ok: true, data: null };
    if (!isProfileConfigured(requested, cfg)) return { ok: false, code: 'invalid', error: `Profile '${requested}' is not configured` };
    if (isSharedProfile(requested, cfg) && !admin) {
      return { ok: false, code: 'forbidden', error: `Profile '${requested}' is shared — admin only` };
    }
    return { ok: true, data: requested };
  }

  if (!profilesEnabled(cfg) || !user.profile) return { ok: true, data: null };
  if (!isProfileConfigured(user.profile, cfg)) {
    return {
      ok: false,
      code: 'invalid',
      error: `Your profile '${user.profile}' is not configured — an admin must add it under profiles: in config.yaml`,
    };
  }
  if (isSharedProfile(user.profile, cfg) && !admin) {
    return { ok: false, code: 'forbidden', error: `Profile '${user.profile}' is shared — admin only` };
  }
  return { ok: true, data: user.profile };
}

/** Profile + role of a task creator / caller by user id ('owner' = synthetic admin). */
export function lookupActor(userId: string | null | undefined): Pick<User, 'role' | 'profile'> | null {
  if (!userId) return null;
  if (userId === OWNER_USER_ID) return OWNER_USER;
  const user = getUser(userId);
  return user.ok ? user.data : null;
}

/**
 * "Free means profile-compatible" (spec §5, §2 rule 6): an agent on profile
 * P serves only users whose profile is P; a shared profile serves admins
 * (and system work with no creator). Agents on no profile (home-dir login)
 * serve everyone, as before profiles existed.
 */
export function isProfileCompatible(
  agentProfile: string | null | undefined,
  actor: Pick<User, 'role' | 'profile'> | null,
  cfg: WaveConfig = getConfig(),
): boolean {
  if (!agentProfile) return true;
  if (isSharedProfile(agentProfile, cfg)) return !actor || actor.role === 'admin';
  return !!actor && actor.profile === agentProfile;
}

/**
 * A runtime started on a profile that has never been logged in sits at the
 * CLI's first-run login menu and swallows whatever WaveCode types into it.
 * Refuse up front with the fix. Home-dir login (null profile) and runtimes
 * without `credential_files` are not checked. Presence only; never contents.
 */
export function requireProfileLogin(
  profile: string | null | undefined,
  runtime: string,
  cfgOverride?: WaveConfig,
): Result<void> {
  if (!profile) return { ok: true, data: undefined }; // home-dir login: nothing to check, no config needed
  const cfg = cfgOverride ?? getConfig();
  const rc = cfg.runtimes[runtime];
  if (!rc?.credential_files?.length) return { ok: true, data: undefined };
  const dir = profileDir(profile, cfg);
  const loggedIn = rc.credential_files.some((f) => fs.existsSync(f.replaceAll('{profile_dir}', dir)));
  if (loggedIn) return { ok: true, data: undefined };
  return {
    ok: false,
    error: `Profile '${profile}' is not logged in for ${runtime} — log it in first (Settings → Profiles, or on the server: wave-login ${runtime} ${profile})`,
  };
}

export interface ProfileStatus {
  name: string;
  shared: boolean;
  /** Per runtime: whether a credential file exists. Contents are never read. */
  runtimes: Record<string, { logged_in: boolean }>;
}

export function profileStatuses(cfg: WaveConfig = getConfig()): ProfileStatus[] {
  return Object.keys(cfg.profiles ?? {}).sort().map((name) => {
    const dir = profileDir(name, cfg);
    const runtimes: ProfileStatus['runtimes'] = {};
    for (const [runtime, rc] of Object.entries(cfg.runtimes)) {
      if (!rc.credential_files?.length) continue;
      runtimes[runtime] = {
        logged_in: rc.credential_files.some((f) => fs.existsSync(f.replaceAll('{profile_dir}', dir))),
      };
    }
    return { name, shared: isSharedProfile(name, cfg), runtimes };
  });
}
