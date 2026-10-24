/**
 * Config for the read-only Ops lanes Live board.
 * One heartbeat JSON per bot lives in a single directory.
 */

export interface OpsLanesConfig {
  /** Directory of `<bot>.json` heartbeats. Default `/home/ci/ops-lanes`. */
  dir?: string;
  /** How often the collector reads those files. Default 10. */
  poll_s?: number;
  /** A heartbeat older than this many minutes turns the row red. Default 2. */
  stale_min?: number;
  /** Bot ids. Default pilot, stager, scout, scribe-hipsl, scribe-clients. */
  bots?: string[];
}

export const DEFAULT_OPS_DIR = '/home/ci/ops-lanes';
export const DEFAULT_OPS_POLL_S = 10;
export const DEFAULT_OPS_STALE_MIN = 2;
export const DEFAULT_OPS_BOTS = ['pilot', 'stager', 'scout', 'scribe-hipsl', 'scribe-clients'] as const;

export interface ResolvedOpsLanes {
  dir: string;
  pollS: number;
  staleMin: number;
  staleS: number;
  bots: string[];
}

export function resolveOpsLanes(input: { ops_lanes?: OpsLanesConfig } | null | undefined): ResolvedOpsLanes {
  const raw = input?.ops_lanes ?? {};
  const pollS = typeof raw.poll_s === 'number' && raw.poll_s >= 1 ? raw.poll_s : DEFAULT_OPS_POLL_S;
  const staleMin = typeof raw.stale_min === 'number' && raw.stale_min >= 0 ? raw.stale_min : DEFAULT_OPS_STALE_MIN;
  const bots = [...new Set((raw.bots ?? [...DEFAULT_OPS_BOTS]).map((bot) => bot.trim()).filter(Boolean))];
  const dir = raw.dir === undefined ? DEFAULT_OPS_DIR : raw.dir.trim();
  return { dir, pollS, staleMin, staleS: staleMin * 60, bots };
}
