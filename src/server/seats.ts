/**
 * One orchestrator seat per user (spec §5d).
 *
 * A seat is an ordinary spawned agent — `role = 'orchestrator'`, owned by the
 * user with a `seat` lease that never expires, on the user's credential
 * profile, named `pm-<user>` — that drives WaveCode over MCP with a *seat
 * token*: a second bearer for the same user, so it acts under that user's
 * role and lease rules and can be revoked without touching the person's own
 * login. Its brief is docs/orchestrator-seat.md + the user's standing rules +
 * the SEAT.md memory instruction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import {
  getAgent,
  getAgentByName,
  getUser,
  hasSeatToken,
  setAgentLease,
  updateAgentRole,
  updateUserSeat,
  type Agent,
  type User,
} from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { briefOrchestratorSeat, resolveOrchestratorAgent } from './orchestrator.js';
import { resolveSpawnProfile } from './profiles.js';
import { daemonUrl, registerSeatMcp, type SeatMcpInput, type SeatMcpResult } from './seat-mcp.js';
import * as sessionManager from './session-manager.js';
import { generateToken, hashToken, OWNER_USER_ID } from './users.js';

export const MAX_SEAT_RULES_CHARS = 2000;
const DEFAULT_SEAT_RUNTIME = 'claude-code';

export type SeatErrorCode = 'forbidden' | 'invalid' | 'conflict' | 'not_found' | 'failed';
export type SeatResult<T> = { ok: true; data: T } | { ok: false; error: string; code: SeatErrorCode };

export function seatErrorStatus(code: SeatErrorCode): 400 | 403 | 404 | 409 | 500 {
  return { forbidden: 403, invalid: 400, conflict: 409, not_found: 404, failed: 500 }[code] as 400 | 403 | 404 | 409 | 500;
}

export function seatName(user: Pick<User, 'name'>): string {
  return `pm-${user.name}`;
}

export function seatWorkspace(name: string): string {
  return path.join(path.dirname(getConfig().paths.worktrees_root), 'seats', name);
}

export type SeatStatus =
  | { status: 'none' }
  | { status: 'ok'; agent: Agent }
  /** The seat was created but its agent is gone — the Center offers to recreate it. */
  | { status: 'missing'; agent_id: string };

export function getSeatStatus(user: Pick<User, 'seat_agent_id'>): SeatStatus {
  if (!user.seat_agent_id) return { status: 'none' };
  const agent = getAgent(user.seat_agent_id);
  return agent.ok ? { status: 'ok', agent: agent.data } : { status: 'missing', agent_id: user.seat_agent_id };
}

/**
 * The agent the Center's Ask goes to for this viewer: their own seat; with
 * no seat ever created, the shared seat (`config.orchestrator_agent`, never
 * someone else's personal seat); with a *missing* seat, none — the Center
 * offers to recreate it instead of silently falling back.
 */
export function defaultSeatFor(viewer: Pick<User, 'id' | 'seat_agent_id'>, agents: Agent[]): Agent | null {
  if (viewer.seat_agent_id) return agents.find((a) => a.id === viewer.seat_agent_id) ?? null;
  // The shared fallback is never another person's seat — held or orphaned
  // (a revoked user's pm-<name> whose lease was released).
  return resolveOrchestratorAgent(agents.filter((a) => a.lease_reason !== 'seat' && !isPersonalSeatName(a.name)));
}

/** `pm-<user>` is the naming scheme for personal seats (seatName). */
export function isPersonalSeatName(name: string): boolean {
  return /^pm-[a-z0-9][a-z0-9_-]*$/.test(name);
}

/** Seat-specific part of the brief: who it serves, their rules, and its SEAT.md memory. */
export function seatBriefExtra(user: Pick<User, 'name' | 'seat_rules'>, workspace: string): string {
  const parts = [
    `You are @${user.name}'s own orchestrator seat: you act as ${user.name} (their role and agent leases apply — you may act on free agents and ${user.name}'s, never on agents other people hold).`,
    `Memory: keep a SEAT.md file at ${path.join(workspace, 'SEAT.md')} with the standing facts you learn (team, conventions, ${user.name}'s preferences and decisions); read it before you answer and update it whenever you learn something lasting.`,
  ];
  const rules = user.seat_rules?.trim();
  if (rules) parts.push(`${user.name}'s standing rules — always follow them: ${rules.replace(/\s+/g, ' ')}`);
  return parts.join(' ');
}

function mcpInput(user: User, agent: Pick<Agent, 'runtime' | 'profile' | 'workspace'>, token: string): SeatMcpInput {
  return { runtime: agent.runtime, profile: agent.profile ?? null, workspace: agent.workspace ?? seatWorkspace(seatName(user)), token, daemonUrl: daemonUrl() };
}

function freshUser(userId: string): User | null {
  const u = getUser(userId);
  return u.ok ? u.data : null;
}

function guardUser(user: Pick<User, 'id' | 'role'>): SeatResult<User> {
  if (user.role === 'observer') return { ok: false, code: 'forbidden', error: 'Observers do not get an orchestrator seat (read-only role)' };
  if (user.id === OWNER_USER_ID) {
    return { ok: false, code: 'invalid', error: 'The fallback-token owner has no user record — create a user for yourself (wavecode user add) to get a seat' };
  }
  const fresh = freshUser(user.id);
  return fresh ? { ok: true, data: fresh } : { ok: false, code: 'not_found', error: 'User not found' };
}

export interface CreatedSeat {
  agent: Agent;
  mcp: SeatMcpResult;
  /** Only when MCP registration failed: the one-time plaintext for manual registration. */
  token?: string;
}

/**
 * Spawn the user's seat (or recreate a missing one): issue a seat token,
 * register MCP in the seat's own config, spawn on the user's profile, take
 * the never-expiring seat lease, brief it (async, once the runtime is up).
 */
export function createSeat(user: Pick<User, 'id' | 'role'>, opts: { runtime?: unknown } = {}): SeatResult<CreatedSeat> {
  const guarded = guardUser(user);
  if (!guarded.ok) return guarded;
  const me = guarded.data;

  const current = getSeatStatus(me);
  if (current.status === 'ok') return { ok: false, code: 'conflict', error: `You already have a seat: ${current.agent.name}` };

  const runtimes = getConfig().runtimes;
  const runtime = opts.runtime === undefined || opts.runtime === null || opts.runtime === ''
    ? (runtimes[DEFAULT_SEAT_RUNTIME] ? DEFAULT_SEAT_RUNTIME : Object.keys(runtimes)[0])
    : opts.runtime;
  if (typeof runtime !== 'string' || !runtimes[runtime]) return { ok: false, code: 'invalid', error: `Unknown runtime '${String(runtime)}'` };

  const profile = resolveSpawnProfile(me, undefined);
  if (!profile.ok) return { ok: false, code: profile.code === 'forbidden' ? 'forbidden' : 'invalid', error: profile.error };

  const name = seatName(me);
  if (getAgentByName(name).ok) {
    return { ok: false, code: 'conflict', error: `An agent named ${name} already exists — remove it or rename it first` };
  }
  const workspace = seatWorkspace(name);
  fs.mkdirSync(workspace, { recursive: true });
  const memory = path.join(workspace, 'SEAT.md');
  if (!fs.existsSync(memory)) fs.writeFileSync(memory, `# SEAT.md — standing facts for @${me.name}'s orchestrator seat\n`, 'utf8');

  // MCP config first: the runtime reads it when it starts
  const token = generateToken();
  const mcp = registerSeatMcp({ runtime, profile: profile.data, workspace, token, daemonUrl: daemonUrl() });
  if (!mcp.ok) logger.warn({ userId: me.id, runtime, error: mcp.error }, 'Seat MCP registration failed');

  const spawned = sessionManager.spawnAgent({ name, runtime, workspace, profile: profile.data });
  if (!spawned.ok) return { ok: false, code: 'failed', error: spawned.error };

  setAgentLease(spawned.data.id, { owner_id: me.id, reason: 'seat', expires_at: null });
  updateAgentRole(spawned.data.id, 'orchestrator');
  updateUserSeat(me.id, { seat_agent_id: spawned.data.id, seat_token_hash: hashToken(token) });
  const agent = getAgent(spawned.data.id);
  if (!agent.ok) return { ok: false, code: 'failed', error: agent.error };

  emit('seat.created', 'agent', agent.data.id, { user: me.name, runtime, profile: profile.data, recreated: current.status === 'missing' });
  void briefOrchestratorSeat(agent.data.id, me.id, { extra: seatBriefExtra(me, workspace) }).catch((err) =>
    logger.warn({ agentId: agent.data.id, error: (err as Error).message }, 'Seat brief failed'),
  );
  // When automatic registration failed the token exists only here: hand it
  // over once so the user can register the MCP server by hand.
  return { ok: true, data: { agent: agent.data, mcp, ...(mcp.ok ? {} : { token }) } };
}

export function setSeatRules(user: Pick<User, 'id' | 'role'>, rules: unknown): SeatResult<User> {
  const guarded = guardUser(user);
  if (!guarded.ok) return guarded;
  if (rules !== null && typeof rules !== 'string') return { ok: false, code: 'invalid', error: 'rules must be text' };
  const text = (rules ?? '').trim();
  if (text.length > MAX_SEAT_RULES_CHARS) return { ok: false, code: 'invalid', error: `rules must be at most ${MAX_SEAT_RULES_CHARS} characters` };
  const updated = updateUserSeat(guarded.data.id, { seat_rules: text || null });
  return updated.ok ? updated : { ok: false, code: 'failed', error: updated.error };
}

/** Send the brief again (after the rules changed); the seat's next answers follow it. */
export async function rebriefSeat(user: Pick<User, 'id' | 'role'>): Promise<SeatResult<void>> {
  const guarded = guardUser(user);
  if (!guarded.ok) return guarded;
  const status = getSeatStatus(guarded.data);
  if (status.status !== 'ok') return { ok: false, code: 'not_found', error: status.status === 'missing' ? 'Your seat is gone — recreate it' : 'You have no seat yet' };
  const sent = await briefOrchestratorSeat(status.agent.id, guarded.data.id, {
    extra: seatBriefExtra(guarded.data, status.agent.workspace ?? seatWorkspace(status.agent.name)),
  });
  return sent.ok ? { ok: true, data: undefined } : { ok: false, code: 'failed', error: sent.error };
}

/** Revoke the seat token: the seat's MCP calls get 401; the person's own login is untouched. */
export function revokeSeatToken(user: Pick<User, 'id' | 'role'>): SeatResult<void> {
  const guarded = guardUser(user);
  if (!guarded.ok) return guarded;
  if (!hasSeatToken(guarded.data.id)) return { ok: false, code: 'not_found', error: 'No seat token to revoke' };
  updateUserSeat(guarded.data.id, { seat_token_hash: null });
  emit('seat.token_revoked', 'user', guarded.data.id, { user: guarded.data.name });
  return { ok: true, data: undefined };
}

/** Issue a new seat token and re-register it in the seat's config (the old one stops working). */
export function rotateSeatToken(user: Pick<User, 'id' | 'role'>): SeatResult<{ mcp: SeatMcpResult; token?: string }> {
  const guarded = guardUser(user);
  if (!guarded.ok) return guarded;
  const status = getSeatStatus(guarded.data);
  if (status.status !== 'ok') return { ok: false, code: 'not_found', error: 'You have no seat to give a token to' };
  const token = generateToken();
  const mcp = registerSeatMcp(mcpInput(guarded.data, status.agent, token));
  updateUserSeat(guarded.data.id, { seat_token_hash: hashToken(token) });
  emit('seat.token_rotated', 'user', guarded.data.id, { user: guarded.data.name, mcp_registered: mcp.ok });
  // Unregistered → the plaintext is handed over once for manual registration
  return { ok: true, data: { mcp, ...(mcp.ok ? {} : { token }) } };
}
