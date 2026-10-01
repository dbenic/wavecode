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
  insertUser,
  isUserRole,
  type Result,
  type User,
  type UserRole,
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
  return getUserByTokenHash(hashToken(token));
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

  const token = generateToken();
  const inserted = insertUser({ name, role, color, token_hash: hashToken(token), profile });
  if (!inserted.ok) return inserted;
  return { ok: true, data: { user: inserted.data, token } };
}

/** Revoke a user (deletes the row, so its token stops resolving). */
export function revokeUser(id: string): Result<void> {
  if (id === OWNER_USER_ID) return { ok: false, error: 'The synthetic owner cannot be revoked' };
  return deleteUser(id) ? { ok: true, data: undefined } : { ok: false, error: `User ${id} not found` };
}
