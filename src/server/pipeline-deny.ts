/**
 * Lanes and agents that get no Countix automation.
 * `lane_deny` is globs over branch names. `agent_deny` is names or aliases,
 * and it also counts as `review_deny` wherever a reviewer is chosen.
 */

import { getConfig } from './config.js';
import { listAgents } from './db.js';

export interface DenyAgent {
  name?: string | null;
  alias?: string | null;
}

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function denyList(project: string | null, key: 'lane_deny' | 'agent_deny'): string[] {
  if (!project) return [];
  const raw = getConfig().projects?.[project]?.pipeline?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

export function laneIsDenied(project: string | null, lane: string | null): boolean {
  if (!project || !lane) return false;
  return denyList(project, 'lane_deny').some((glob) => {
    try { return globToRe(glob.trim()).test(lane); } catch { return false; }
  });
}

export function agentIsDenied(project: string | null, agent: DenyAgent | null | undefined): boolean {
  if (!project || !agent) return false;
  const denied = new Set(denyList(project, 'agent_deny').map((s) => s.trim().toLowerCase()));
  if (denied.size === 0) return false;
  const names = [agent.name, agent.alias].filter((s): s is string => !!s).map((s) => s.toLowerCase());
  return names.some((n) => denied.has(n));
}

/** The agent a `wc-<name>` lane belongs to, when one is registered. */
function laneAgent(lane: string): DenyAgent | null {
  const bare = lane.replace(/^wc-/i, '');
  try {
    return listAgents().find((a) =>
      a.tmux_session === lane
      || a.name.toLowerCase() === bare.toLowerCase()
      || a.name.toLowerCase() === lane.toLowerCase()
      || a.alias?.toLowerCase() === bare.toLowerCase()
      || a.alias?.toLowerCase() === lane.toLowerCase(),
    ) ?? null;
  } catch {
    return null;
  }
}

/**
 * True when this lane or agent must not be merged, pinged, frozen, listed,
 * or assigned a review. A `wc-<name>` lane is denied when `<name>` is.
 */
export function countixDenied(project: string | null, lane: string | null, agent?: DenyAgent | null): boolean {
  if (!project) return false;
  if (lane && laneIsDenied(project, lane)) return true;
  if (agentIsDenied(project, agent)) return true;
  if (!lane) return false;
  const bare = lane.replace(/^wc-/i, '');
  if (agentIsDenied(project, { name: bare, alias: lane })) return true;
  const implied = laneAgent(lane);
  return implied ? agentIsDenied(project, implied) : false;
}
