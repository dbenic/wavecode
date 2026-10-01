/**
 * `wavecode profile login <name> <runtime>` (spec §5): log a credential
 * profile in from a shell on the server. Runs the runtime's login command
 * in the foreground with the profile env (CLAUDE_CONFIG_DIR / CODEX_HOME /
 * HOME), so it ends when the login does — no tmux seat needed. Browser
 * users get the same thing as a login seat via POST /api/profiles/:name/login.
 */

import type { WaveConfig } from '../server/config.js';
import type { Result } from '../server/db.js';
import { isProfileConfigured, isValidProfileName, profileDir, resolveProfileEnv } from '../server/profiles.js';

export interface LoginInvocation {
  command: string;
  args: string[];
  /** Only the profile vars; the caller merges them over process.env. */
  env: Record<string, string>;
  cwd: string;
  profile: string;
}

export function buildLoginInvocation(profile: string, runtime: string, cfg: WaveConfig): Result<LoginInvocation> {
  if (!isValidProfileName(profile) || !isProfileConfigured(profile, cfg)) {
    const known = Object.keys(cfg.profiles ?? {});
    return { ok: false, error: `Profile '${profile}' is not configured${known.length ? ` (configured: ${known.join(', ')})` : ' — add it under profiles: in config.yaml'}` };
  }
  const rc = cfg.runtimes[runtime];
  if (!rc) return { ok: false, error: `Unknown runtime '${runtime}' (configured: ${Object.keys(cfg.runtimes).join(', ')})` };
  if (!rc.login_command?.trim()) return { ok: false, error: `Runtime '${runtime}' has no login_command configured` };

  const env = resolveProfileEnv(runtime, profile, cfg);
  if (!env.ok) return env;

  // Spawned without a shell: the command is split on whitespace, never interpreted
  const [command, ...args] = rc.login_command.trim().split(/\s+/);
  return { ok: true, data: { command, args, env: env.data, cwd: profileDir(profile, cfg), profile } };
}
