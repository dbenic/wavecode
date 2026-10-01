/**
 * Dependency-free validators for credential profiles (spec §5), shared by
 * config loading and profiles.ts. Env values end up in a shell command, so
 * the alphabet is as strict as model pins: paths and plain tokens only.
 */

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
// No spaces, quotes, `$`, backticks, `;`, `&`, `|`, `~`, `*`, `=` …
const ENV_VALUE_RE = /^[A-Za-z0-9/][A-Za-z0-9._/:@+-]{0,511}$/;

export function isValidProfileName(name: unknown): name is string {
  return typeof name === 'string' && PROFILE_NAME_RE.test(name);
}

export function isSafeEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

export function isSafeEnvValue(value: string): boolean {
  return ENV_VALUE_RE.test(value) && !value.split('/').includes('..');
}

interface ProfilesConfigShape {
  profiles_root: string;
  profiles: Record<string, unknown>;
  runtimes: Record<string, { env?: Record<string, string> }>;
}

/** Startup check: profile names, profiles_root and runtime env names must be safe. */
export function validateProfilesConfig(cfg: ProfilesConfigShape): string[] {
  const errors: string[] = [];
  const names = Object.keys(cfg.profiles ?? {});
  for (const name of names) {
    if (!isValidProfileName(name)) errors.push(`profiles.${name}: name must match ${PROFILE_NAME_RE}`);
  }
  if (names.length > 0 && !isSafeEnvValue(cfg.profiles_root)) {
    errors.push(`profiles_root '${cfg.profiles_root}' contains characters not allowed in a launch command`);
  }
  for (const [runtime, rc] of Object.entries(cfg.runtimes ?? {})) {
    for (const key of Object.keys(rc.env ?? {})) {
      if (!isSafeEnvKey(key)) errors.push(`runtimes.${runtime}.env.${key}: invalid variable name`);
    }
  }
  return errors;
}
