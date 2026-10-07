/**
 * Identity (multi-orchestrator spec §1): bearer tokens → users.
 *
 * Tokens are generated here, returned to the caller exactly once, and only
 * their sha256 is stored. `auth.fallback_token` maps to the synthetic admin
 * user `owner`, which is never a row in `users` (so existing installs keep
 * working without a migration step).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  deleteUser,
  getUserByTokenHash,
  getUserBySeatTokenHash,
  insertUser,
  isUserRole,
  type Result,
  type User,
  type UserRole,
  type Agent,
} from './db.js';

export const OWNER_USER_ID = 'owner';

/** Synthetic admin that `auth.fallback_token` (and trusted tailnet access) resolves to. */
export const OWNER_USER: User = Object.freeze({
  id: OWNER_USER_ID,
  name: 'owner',
  role: 'admin',
  color: '#64748b',
  // The fallback token runs agents on the service user's own (home-dir) login.
  profile: null,
  created_at: '1970-01-01 00:00:00',
});

const RESERVED_NAMES = new Set([OWNER_USER.name, 'system', 'all']);
const USER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const PALETTE = ['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626'];

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateToken(): string {
  return `wc_${randomBytes(32).toString('base64url')}`;
}

function pickColor(name: string): string {
  const digest = createHash('sha256').update(name).digest();
  return PALETTE[digest[0] % PALETTE.length];
}

function tokensEqual(a: string, b: string): boolean {
  const ha = Buffer.from(hashToken(a), 'hex');
  const hb = Buffer.from(hashToken(b), 'hex');
  return timingSafeEqual(ha, hb);
}

/**
 * Resolve a bearer token to a user. The fallback token wins (synthetic
 * `owner`); otherwise the token's hash is looked up in `users`.
 */
export function resolveUserByToken(token: string | null, fallbackToken: string | null): User | null {
  if (!token) return null;
  if (fallbackToken && tokensEqual(token, fallbackToken)) return OWNER_USER;
  const hash = hashToken(token);
  // A seat token (spec §5d) is a second bearer for the same user: the seat
  // acts under that user's role and lease rules, and can be revoked alone.
  // It is marked, so a seat can be held to "propose, don't edit" (spec §5f).
  const person = getUserByTokenHash(hash);
  if (person) return isExpired(person) ? null : person;
  const seatUser = getUserBySeatTokenHash(hash);
  if (!seatUser || isExpired(seatUser)) return null; // the seat expires with its person
  return { ...seatUser, via_seat: true };
}

/**
 * Token expiry, exact UTC instant: at `expires_at` the token is already
 * invalid. An unparseable value fails closed (expired).
 */
export function isExpired(user: Pick<User, 'expires_at'>, now: number = Date.now()): boolean {
  const raw = user.expires_at;
  if (raw === undefined || raw === null || raw === '') return false;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return true;
  return now >= t;
}

/** "30d" / "12h" / "90m" or an ISO instant → ISO UTC; null = never. */
export function parseExpiry(input: unknown, now: number = Date.now()): Result<string | null> {
  if (input === undefined || input === null || input === '') return { ok: true, data: null };
  if (typeof input !== 'string') return { ok: false, error: 'expires must be "30d", "12h", "90m" or an ISO date' };
  const rel = /^(\d+)([mhd])$/.exec(input.trim());
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2] === 'm' ? n * 60_000 : rel[2] === 'h' ? n * 3_600_000 : n * 86_400_000;
    if (n <= 0 || ms > 366 * 86_400_000) return { ok: false, error: 'expires must be between 1m and 366d' };
    return { ok: true, data: new Date(now + ms).toISOString() };
  }
  const t = Date.parse(input);
  if (Number.isNaN(t)) return { ok: false, error: 'expires must be "30d", "12h", "90m" or an ISO date' };
  if (t <= now) return { ok: false, error: 'expires is already in the past' };
  return { ok: true, data: new Date(t).toISOString() };
}

export function canMutate(user: Pick<User, 'role'>): boolean {
  return user.role !== 'observer';
}

export function isAdmin(user: Pick<User, 'role'>): boolean {
  return user.role === 'admin';
}

export interface CreateUserInput {
  name: unknown;
  role?: unknown;
  color?: unknown;
  /** Credential profile (spec §5); defaults to the user name. */
  profile?: unknown;
  /** Restrict this token to these agents (refs: id, name or alias) — a peer's "ask-only" token (docs/peers.md). */
  only_agents?: unknown;
  /** Token lifetime: "30d", "12h", "90m" or an ISO instant; default never. */
  expires?: unknown;
}

export interface CreatedUser {
  user: User;
  /** Plaintext bearer token — shown once, never stored. */
  token: string;
}

export function createUser(input: CreateUserInput): Result<CreatedUser> {
  const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : '';
  if (!USER_NAME_RE.test(name)) {
    return { ok: false, error: 'name must be 1-32 chars of [a-z0-9_-], starting with a letter or digit' };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: `name '${name}' is reserved` };
  }

  const role: UserRole | null = input.role === undefined || input.role === null
    ? 'developer'
    : isUserRole(input.role) ? input.role : null;
  if (!role) return { ok: false, error: 'role must be one of: admin, developer, observer' };

  let color: string;
  if (input.color === undefined || input.color === null || input.color === '') {
    color = pickColor(name);
  } else if (typeof input.color === 'string' && COLOR_RE.test(input.color)) {
    color = input.color.toLowerCase();
  } else {
    return { ok: false, error: 'color must be a hex color like #2563eb' };
  }

  let profile = name;
  if (input.profile !== undefined && input.profile !== null && input.profile !== '') {
    if (typeof input.profile !== 'string' || !USER_NAME_RE.test(input.profile)) {
      return { ok: false, error: 'profile must be 1-32 chars of [a-z0-9_-]' };
    }
    profile = input.profile;
  }

  let allowedAgents: string[] | null = null;
  if (input.only_agents !== undefined && input.only_agents !== null) {
    const list = Array.isArray(input.only_agents) ? input.only_agents : typeof input.only_agents === 'string' ? input.only_agents.split(',') : null;
    const refs = list?.map((r) => (typeof r === 'string' ? r.trim().replace(/^@/, '') : '')).filter(Boolean) ?? [];
    if (!list || refs.length === 0 || refs.some((r) => r.length > 64)) {
      return { ok: false, error: 'only_agents must be a non-empty list of agent refs (id, name or alias)' };
    }
    if (role === 'admin') return { ok: false, error: 'an admin cannot be restricted to agents — use role developer' };
    allowedAgents = refs;
  }

  const expiry = parseExpiry(input.expires);
  if (!expiry.ok) return expiry;

  const token = generateToken();
  const inserted = insertUser({ name, role, color, token_hash: hashToken(token), profile, allowed_agents: allowedAgents, expires_at: expiry.data });
  if (!inserted.ok) return inserted;
  return { ok: true, data: { user: inserted.data, token } };
}

/**
 * Agent refs a restricted user may touch; null = unrestricted. FAIL CLOSED:
 * a restriction that is present but malformed, empty or not an array denies
 * every agent (empty list) rather than lifting the restriction.
 */
export function restrictedAgentRefs(user: Pick<User, 'allowed_agents'> | null | undefined): string[] | null {
  const raw = user?.allowed_agents;
  if (raw === undefined || raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const refs = parsed.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
    return refs; // [] when nothing valid remains → restricted to nothing
  } catch {
    return [];
  }
}

export function isRestrictedUser(user: Pick<User, 'allowed_agents'> | null | undefined): boolean {
  return restrictedAgentRefs(user) !== null;
}

/** May this user touch this agent? Unrestricted users: yes (leases decide). Restricted: only the named ones. */
export function agentAllowedFor(user: Pick<User, 'allowed_agents'>, agent: Pick<Agent, 'id' | 'name' | 'alias'>): boolean {
  const refs = restrictedAgentRefs(user);
  if (!refs) return true;
  return refs.includes(agent.id) || refs.includes(agent.name) || (!!agent.alias && refs.includes(agent.alias));
}

/** Revoke a user (deletes the row, so its token stops resolving). */
export function revokeUser(id: string): Result<void> {
  if (id === OWNER_USER_ID) return { ok: false, error: 'The synthetic owner cannot be revoked' };
  return deleteUser(id) ? { ok: true, data: undefined } : { ok: false, error: `User ${id} not found` };
}
