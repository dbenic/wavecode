/**
 * `wavecode user add <name> [--role]` — local bootstrap for identity
 * (multi-orchestrator spec §1). Writes straight to the SQLite file like the
 * other local CLI commands, so the first admin can be created without a
 * browser or a running daemon. The plaintext token is printed once.
 */

import type { Result } from '../server/db.js';
import { createUser, type CreatedUser } from '../server/users.js';

export interface AddUserOptions {
  role?: string;
  color?: string;
  profile?: string;
  /** Comma-separated agent refs: the token may only ask/read these (a peer's ask-only token). */
  onlyAgents?: string;
}

export function addUserCommand(name: string, opts: AddUserOptions = {}): Result<CreatedUser> {
  return createUser({ name, role: opts.role, color: opts.color, profile: opts.profile, only_agents: opts.onlyAgents });
}

export function formatCreatedUser({ user, token }: CreatedUser): string {
  return [
    `User ${user.name} (${user.role}, profile ${user.profile ?? 'none'}) created — id ${user.id}`,
    `Token (shown once, store it now): ${token}`,
    'Use it as: Authorization: Bearer <token>  (or WAVECODE_TOKEN=<token>)',
  ].join('\n');
}
