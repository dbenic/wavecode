/**
 * Agent leases (multi-orchestrator spec §2).
 *
 * An agent is either free (`owner_id IS NULL`) or owned by one user. Only
 * the owner or an admin may act on an owned agent (send, kill, assign,
 * hand off); everyone may still read it. Leases come from an explicit
 * reservation (`reserved`, with expiry) or from the dispatcher assigning a
 * task to a free agent (`task`, released when the agent goes idle).
 */

import {
  clearAgentLease,
  getAgent,
  getUser,
  hasOpenRun,
  listAgents,
  listAgentsOwnedBy,
  setAgentLease,
  type Agent,
  type Task,
  type User,
} from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { OWNER_USER, OWNER_USER_ID, agentAllowedFor, restrictedAgentRefs } from './users.js';
import { isProfileCompatible, lookupActor } from './profiles.js';

export const DEFAULT_RESERVE_HOURS = 4;
export const MAX_RESERVE_HOURS = 24;

export type LeaseErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'invalid';
export type LeaseResult<T> = { ok: true; data: T } | { ok: false; error: string; code: LeaseErrorCode };

/** HTTP status for a lease error code. */
export function leaseErrorStatus(code: LeaseErrorCode): 400 | 403 | 404 | 409 {
  switch (code) {
    case 'not_found': return 404;
    case 'forbidden': return 403;
    case 'conflict': return 409;
    default: return 400;
  }
}

/** Display name for a user id (falls back to the id for unknown/revoked users). */
export function userName(userId: string): string {
  if (userId === OWNER_USER_ID) return OWNER_USER.name;
  const user = getUser(userId);
  return user.ok ? user.data.name : userId;
}

function isAdminUserId(userId: string): boolean {
  if (userId === OWNER_USER_ID) return true;
  const user = getUser(userId);
  return user.ok && user.data.role === 'admin';
}

export function isFree(agent: Pick<Agent, 'owner_id'>): boolean {
  return !agent.owner_id;
}

/** Rule 2: free, own, or admin. The error names the owner. */
export function checkAgentAccess(agent: Agent, user: Pick<User, 'id' | 'role'> & { allowed_agents?: string | null }): LeaseResult<void> {
  // A restricted token (docs/peers.md) reaches only its named agents, whatever the leases say.
  if (!agentAllowedFor(user, agent)) {
    return { ok: false, code: 'forbidden', error: `This token is limited to: ${restrictedAgentRefs(user)!.join(', ')}` };
  }
  if (!agent.owner_id || agent.owner_id === user.id || user.role === 'admin') {
    return { ok: true, data: undefined };
  }
  return {
    ok: false,
    code: 'forbidden',
    error: `Agent ${agent.name} is owned by ${userName(agent.owner_id)}`,
  };
}

function isBusy(agent: Agent): boolean {
  return agent.status === 'working' || hasOpenRun(agent.id);
}

/** Rule 4: explicit reservation, default 4h, max 24h. Re-reserving your own agent extends it. */
export function reserveAgent(agentId: string, user: Pick<User, 'id'>, hours?: unknown): LeaseResult<Agent> {
  const h = hours === undefined || hours === null ? DEFAULT_RESERVE_HOURS : hours;
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_RESERVE_HOURS) {
    return { ok: false, code: 'invalid', error: `hours must be a number in (0, ${MAX_RESERVE_HOURS}]` };
  }

  const existing = getAgent(agentId);
  if (!existing.ok) return { ok: false, code: 'not_found', error: existing.error };
  const agent = existing.data;
  if (agent.owner_id && agent.owner_id !== user.id) {
    return { ok: false, code: 'conflict', error: `Agent ${agent.name} is owned by ${userName(agent.owner_id)}` };
  }
  if (agent.lease_reason === 'seat') {
    // A seat's lease never expires; a reservation would put an expiry on it
    return { ok: false, code: 'conflict', error: `${agent.name} is ${userName(agent.owner_id!)}'s orchestrator seat — it is always theirs` };
  }

  const until = new Date(Date.now() + h * 3_600_000).toISOString();
  const updated = setAgentLease(agent.id, { owner_id: user.id, reason: 'reserved', expires_at: until });
  if (!updated.ok) return { ok: false, code: 'conflict', error: updated.error };

  emit('agent.reserved', 'agent', agent.id, { owner: userName(user.id), owner_id: user.id, until, reason: 'reserved' });
  logger.info({ agentId: agent.id, ownerId: user.id, until }, 'Agent reserved');
  return { ok: true, data: updated.data };
}

/** Owner or admin clears the lease. Releasing a free agent is a no-op. */
export function releaseAgent(agentId: string, user: Pick<User, 'id' | 'role'>): LeaseResult<Agent> {
  const existing = getAgent(agentId);
  if (!existing.ok) return { ok: false, code: 'not_found', error: existing.error };
  const agent = existing.data;
  if (!agent.owner_id) return { ok: true, data: agent };

  const access = checkAgentAccess(agent, user);
  if (!access.ok) return access;
  if (agent.lease_reason === 'seat') {
    return { ok: false, code: 'conflict', error: `${agent.name} is an orchestrator seat — it is never released (delete the seat instead)` };
  }

  const updated = clearAgentLease(agent.id);
  if (!updated.ok) return { ok: false, code: 'not_found', error: updated.error };
  emit('agent.released', 'agent', agent.id, {
    by: userName(user.id),
    owner: userName(agent.owner_id),
    reason: agent.owner_id === user.id ? 'released' : 'force_released',
  });
  return { ok: true, data: updated.data };
}

/**
 * Rule 6: a task may go to a free agent, or one owned by the task's creator.
 * A task explicitly assigned to this agent by an admin also passes — admins
 * may assign to any agent (rule 2), so the dispatcher honors it.
 */
export function canDispatchTaskToAgent(task: Task, agent: Agent): boolean {
  return waitReason(task, agent) === null;
}

/**
 * Why `task` may not run on `agent` right now, or null if it may.
 * - 'profile' (spec §5): the agent runs on another subscription — nobody's
 *   task may burn someone else's quota, admins included (except `shared`).
 * - 'owner' (§2 rule 6): someone else holds the lease.
 */
export function waitReason(task: Task, agent: Agent): 'profile' | 'owner' | null {
  if (agent.profile && !isProfileCompatible(agent.profile, lookupActor(task.created_by))) return 'profile';
  if (!agent.owner_id) return null;
  if (task.created_by && task.created_by === agent.owner_id) return null;
  if (task.agent_id === agent.id && !!task.created_by && isAdminUserId(task.created_by)) return null;
  return 'owner';
}

/** Rule 3: dispatching a task to a free agent leases it to the task's creator. */
export function autoLeaseForTask(agent: Agent, task: Task): boolean {
  if (agent.owner_id || !task.created_by) return false;
  const updated = setAgentLease(agent.id, { owner_id: task.created_by, reason: 'task', expires_at: null });
  if (!updated.ok) return false;
  agent.owner_id = task.created_by;
  agent.lease_reason = 'task';
  agent.lease_expires_at = null;
  emit('agent.reserved', 'agent', agent.id, {
    owner: userName(task.created_by),
    owner_id: task.created_by,
    until: null,
    reason: 'task',
    task_id: task.id,
  }, null);
  return true;
}

/**
 * Rule 3 (release): a task lease ends once the agent is idle with no open
 * run. Explicit reservations are kept.
 */
export function maybeReleaseTaskLease(agentId: string): boolean {
  const existing = getAgent(agentId);
  if (!existing.ok) return false;
  const agent = existing.data;
  if (!agent.owner_id || agent.lease_reason !== 'task' || isBusy(agent)) return false;

  clearAgentLease(agent.id);
  emit('agent.released', 'agent', agent.id, { by: null, owner: userName(agent.owner_id), reason: 'task_complete' }, null);
  return true;
}

/**
 * Rule 5 (health-monitor tick): release reservations past `lease_expires_at`
 * on idle agents, and task leases whose agent has gone idle. Working agents
 * are never yanked — their lease simply runs until they go idle.
 */
export function sweepLeases(now = Date.now()): string[] {
  const released: string[] = [];
  for (const agent of listAgents()) {
    if (!agent.owner_id) continue;
    if (agent.lease_reason === 'task') {
      if (maybeReleaseTaskLease(agent.id)) released.push(agent.id);
      continue;
    }
    if (!agent.lease_expires_at || Date.parse(agent.lease_expires_at) > now) continue;
    if (isBusy(agent)) continue;

    clearAgentLease(agent.id);
    emit('agent.lease_expired', 'agent', agent.id, {
      owner: userName(agent.owner_id),
      owner_id: agent.owner_id,
      expired_at: agent.lease_expires_at,
    }, null);
    logger.info({ agentId: agent.id, ownerId: agent.owner_id }, 'Agent lease expired');
    released.push(agent.id);
  }
  return released;
}

/** On user revoke: emulate `ON DELETE SET NULL` for that user's leases. */
export function releaseLeasesOf(userId: string): number {
  const owned = listAgentsOwnedBy(userId);
  for (const agent of owned) {
    clearAgentLease(agent.id);
    emit('agent.released', 'agent', agent.id, { by: null, owner_id: userId, reason: 'user_revoked' });
  }
  return owned.length;
}
