/**
 * Maps the person looking at the dashboard to the lanes they own.
 * `users` is the logged-in name. `tokens` is the bearer they presented.
 * Neither match means the board shows every lane.
 */

import { getConfig, type DeveloperConfig } from './config.js';

export function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export function laneMatches(globs: string[], lane: string | null): boolean {
  if (!lane) return false;
  return globs.some((glob) => {
    try { return globToRe(glob.trim()).test(lane); } catch { return false; }
  });
}

export function matchDeveloper(
  list: DeveloperConfig[] | undefined,
  identity: { name: string },
  token: string | null,
): DeveloperConfig | null {
  const name = identity.name.trim().toLowerCase();
  for (const dev of list ?? []) {
    if (dev.users?.some((user) => user.toLowerCase() === name)) return dev;
    if (token && dev.tokens?.some((entry) => entry === token)) return dev;
  }
  return null;
}

export function developerFor(identity: { name: string }, token: string | null): DeveloperConfig | null {
  try {
    return matchDeveloper(getConfig().developers, identity, token);
  } catch {
    return null;
  }
}

export function developerRoster(): Array<{ name: string; lanes: string[] }> {
  try {
    return (getConfig().developers ?? []).map((dev) => ({ name: dev.name, lanes: dev.lanes }));
  } catch {
    return [];
  }
}
