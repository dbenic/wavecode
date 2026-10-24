/**
 * Config for the Ops lanes Live board and the job store.
 * Heartbeats are one `<role>.json` in `/srv/opsbots/heartbeat`.
 * Receipts the bots write live under `/srv/opsbots/receipts/<role>/`.
 * WaveCode records jobs. It does not run the opsbots scripts.
 */

export const OPS_JOB_ROLES = ['stager', 'scout', 'scribe-hipsl', 'scribe-clients'] as const;
export type OpsJobRole = (typeof OPS_JOB_ROLES)[number];

export interface OpsPuller {
  /** User name the bot's bearer token resolves to. */
  user: string;
  role: OpsJobRole;
}

export interface OpsLanesConfig {
  /** Directory of `<role>.json` heartbeats. Default `/srv/opsbots/heartbeat`. */
  dir?: string;
  /** How often the collector reads those files. Default 10. */
  poll_s?: number;
  /** A heartbeat older than this many minutes turns the row red. Default 2. */
  stale_min?: number;
  /** Role filenames. Default pilot, stager, scout, scribe-hipsl, scribe-clients. */
  roles?: string[];
  /** Receipt files must realpath under `<receipts_root>/<role>/`. Default `/srv/opsbots/receipts`. */
  receipts_root?: string;
  /** User names who may record approval. Default denis and antonio. */
  owners?: string[];
  /**
   * Which user may pull which role. When omitted, a user whose name is the
   * role (the `stager` user pulls `stager`) is bound to that role.
   */
  pullers?: OpsPuller[];
  /** Company id → scribe role for a write that is waiting on an owner. */
  companies?: Record<string, OpsJobRole>;
}

export const DEFAULT_OPS_DIR = '/srv/opsbots/heartbeat';
export const DEFAULT_OPS_RECEIPTS = '/srv/opsbots/receipts';
export const DEFAULT_OPS_POLL_S = 10;
export const DEFAULT_OPS_STALE_MIN = 2;
export const DEFAULT_OPS_ROLES = ['pilot', 'stager', 'scout', 'scribe-hipsl', 'scribe-clients'] as const;
export const DEFAULT_OPS_OWNERS = ['denis', 'antonio'] as const;
export const DEFAULT_OPS_COMPANIES: Record<string, OpsJobRole> = {
  hipsl: 'scribe-hipsl',
  clients: 'scribe-clients',
};

export interface ResolvedOpsLanes {
  dir: string;
  pollS: number;
  staleMin: number;
  staleS: number;
  roles: string[];
  receiptsRoot: string;
  owners: string[];
  /** Empty means "a user named the role may pull it". */
  pullers: OpsPuller[];
  companies: Record<string, OpsJobRole>;
}

export function isOpsJobRole(value: string): value is OpsJobRole {
  return (OPS_JOB_ROLES as readonly string[]).includes(value);
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return name ? name : null;
}

export function resolveOpsLanes(input: { ops_lanes?: OpsLanesConfig } | null | undefined): ResolvedOpsLanes {
  const raw = input?.ops_lanes ?? {};
  const pollS = typeof raw.poll_s === 'number' && raw.poll_s >= 1 ? raw.poll_s : DEFAULT_OPS_POLL_S;
  const staleMin = typeof raw.stale_min === 'number' && raw.stale_min >= 0 ? raw.stale_min : DEFAULT_OPS_STALE_MIN;
  const roles = [...new Set((raw.roles ?? [...DEFAULT_OPS_ROLES]).map((role) => role.trim()).filter(Boolean))];
  const dir = raw.dir === undefined ? DEFAULT_OPS_DIR : raw.dir.trim();
  const receiptsRoot = raw.receipts_root === undefined || raw.receipts_root.trim() === ''
    ? DEFAULT_OPS_RECEIPTS
    : raw.receipts_root.trim();
  const owners = raw.owners === undefined
    ? [...DEFAULT_OPS_OWNERS]
    : [...new Set(raw.owners.map((name) => cleanName(name)).filter((name): name is string => !!name))];
  const pullers: OpsPuller[] = [];
  for (const row of raw.pullers ?? []) {
    const user = cleanName(row?.user);
    const role = typeof row?.role === 'string' ? row.role.trim() : '';
    if (!user || !isOpsJobRole(role)) continue;
    if (!pullers.some((existing) => existing.user === user)) pullers.push({ user, role });
  }
  const companies: Record<string, OpsJobRole> = raw.companies === undefined ? { ...DEFAULT_OPS_COMPANIES } : {};
  if (raw.companies) {
    for (const [company, role] of Object.entries(raw.companies)) {
      const id = cleanName(company);
      if (id && isOpsJobRole(role)) companies[id] = role;
    }
  }
  return { dir, pollS, staleMin, staleS: staleMin * 60, roles, receiptsRoot, owners, pullers, companies };
}

/**
 * The role this caller may pull. A configured puller list replaces the
 * name-equals-role default. A seat token is an agent, not the bot.
 */
export function boundOpsRole(user: { name: string; via_seat?: boolean }, cfg: ResolvedOpsLanes): OpsJobRole | null {
  if (user.via_seat) return null;
  const name = user.name.trim().toLowerCase();
  if (cfg.pullers.length > 0) return cfg.pullers.find((row) => row.user === name)?.role ?? null;
  return isOpsJobRole(name) ? name : null;
}

export function isOpsOwner(user: { name: string; via_seat?: boolean }, cfg: ResolvedOpsLanes): boolean {
  if (user.via_seat) return false;
  return cfg.owners.includes(user.name.trim().toLowerCase());
}
