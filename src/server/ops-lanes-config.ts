/**
 * Config for the read-only Ops lanes Live board.
 * One `<role>.json` heartbeat lives in `/srv/opsbots/heartbeat`.
 */

export interface OpsLanesConfig {
  /** Directory of `<role>.json` heartbeats. Default `/srv/opsbots/heartbeat`. */
  dir?: string;
  /** How often the collector reads those files. Default 10. */
  poll_s?: number;
  /** A heartbeat older than this many minutes turns the row red. Default 2. */
  stale_min?: number;
  /** Role filenames. Default pilot, stager, scout, scribe-hipsl, scribe-clients. */
  roles?: string[];
}

export const DEFAULT_OPS_DIR = '/srv/opsbots/heartbeat';
export const DEFAULT_OPS_POLL_S = 10;
export const DEFAULT_OPS_STALE_MIN = 2;
export const DEFAULT_OPS_ROLES = ['pilot', 'stager', 'scout', 'scribe-hipsl', 'scribe-clients'] as const;

export interface ResolvedOpsLanes {
  dir: string;
  pollS: number;
  staleMin: number;
  staleS: number;
  roles: string[];
}

export function resolveOpsLanes(input: { ops_lanes?: OpsLanesConfig } | null | undefined): ResolvedOpsLanes {
  const raw = input?.ops_lanes ?? {};
  const pollS = typeof raw.poll_s === 'number' && raw.poll_s >= 1 ? raw.poll_s : DEFAULT_OPS_POLL_S;
  const staleMin = typeof raw.stale_min === 'number' && raw.stale_min >= 0 ? raw.stale_min : DEFAULT_OPS_STALE_MIN;
  const roles = [...new Set((raw.roles ?? [...DEFAULT_OPS_ROLES]).map((role) => role.trim()).filter(Boolean))];
  const dir = raw.dir === undefined ? DEFAULT_OPS_DIR : raw.dir.trim();
  return { dir, pollS, staleMin, staleS: staleMin * 60, roles };
}
