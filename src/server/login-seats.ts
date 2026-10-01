/**
 * Login seats (spec §5 "Login without SSH"): a throwaway tmux session
 * `wc-login-<profile>-<runtime>` running the runtime's login command with
 * the profile env, registered as an adopted agent so the developer can open
 * it in AgentView, read the device-code URL and finish OAuth on their phone.
 *
 * Lifecycle: the command is followed by `; exit`, so the session ends when
 * the login finishes; a watcher reaps the seat on exit, or kills it after
 * 15 minutes. Seats are reserved for the requester (nobody else can type
 * into their OAuth flow), never dispatched to, and skipped by the health
 * monitor. A daemon restart loses the watchers — sweepLoginSeats() reaps
 * orphans from the health-monitor tick.
 */

import {
  deleteAgent,
  getAgent,
  getAgentByName,
  insertAgent,
  setAgentLease,
  type Agent,
  type User,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import {
  ensureProfileDirs,
  isProfileConfigured,
  isSharedProfile,
  isValidProfileName,
  profileDir,
  profileStatuses,
  resolveProfileEnv,
} from './profiles.js';
import { buildRuntimeCommand } from './runtime-launcher.js';
import * as tmux from './tmux.js';

export const LOGIN_SEAT_TTL_MS = 15 * 60_000;
export const LOGIN_SEAT_POLL_MS = 5_000;
const LOGIN_SESSION_PREFIX = 'wc-login-';

export function isLoginSeat(agent: Pick<Agent, 'tmux_session'>): boolean {
  return agent.tmux_session.startsWith(LOGIN_SESSION_PREFIX);
}

export function loginSessionName(profile: string, runtime: string): string {
  return `${LOGIN_SESSION_PREFIX}${profile}-${runtime}`;
}

interface SeatWatch {
  agentId: string;
  session: string;
  profile: string;
  runtime: string;
  deadline: number;
  timer: ReturnType<typeof setInterval>;
}

const watches = new Map<string, SeatWatch>();

export type LoginSeatErrorCode = 'forbidden' | 'invalid' | 'conflict' | 'failed';
export type LoginSeatResult<T> = { ok: true; data: T } | { ok: false; error: string; code: LoginSeatErrorCode };

export function loginSeatErrorStatus(code: LoginSeatErrorCode): 400 | 403 | 409 | 500 {
  return code === 'forbidden' ? 403 : code === 'conflict' ? 409 : code === 'failed' ? 500 : 400;
}

/** The profile's owner (users.profile === name) or an admin; shared profiles are admin-only. */
export function canLoginProfile(user: Pick<User, 'role' | 'profile'>, profile: string): boolean {
  if (user.role === 'admin') return true;
  return !isSharedProfile(profile) && user.profile === profile;
}

export function openLoginSeat(opts: {
  profile: string;
  runtime: string;
  user: Pick<User, 'id' | 'role' | 'profile'>;
}): LoginSeatResult<{ agent: Agent; session: string; expires_at: string }> {
  const { profile, runtime, user } = opts;
  if (!isValidProfileName(profile) || !isProfileConfigured(profile)) {
    return { ok: false, code: 'invalid', error: `Profile '${profile}' is not configured` };
  }
  if (!canLoginProfile(user, profile)) {
    return { ok: false, code: 'forbidden', error: `Only the owner of profile '${profile}' or an admin may log it in` };
  }
  const rc = getConfig().runtimes[runtime];
  if (!rc) return { ok: false, code: 'invalid', error: `Unknown runtime '${runtime}'` };
  if (!rc.login_command) return { ok: false, code: 'invalid', error: `Runtime '${runtime}' has no login_command configured` };

  const session = loginSessionName(profile, runtime);
  if (!tmux.isValidSessionName(session)) return { ok: false, code: 'invalid', error: `Invalid session name '${session}'` };
  if (tmux.hasSession(session)) {
    return { ok: false, code: 'conflict', error: `A login seat for ${profile}/${runtime} is already open` };
  }

  const env = resolveProfileEnv(runtime, profile);
  if (!env.ok) return { ok: false, code: 'invalid', error: env.error };

  // A stale record from a seat whose watcher was lost (daemon restart)
  const stale = getAgentByName(`login-${profile}-${runtime}`);
  if (stale.ok) closeLoginSeat(stale.data.id, 'replaced');

  const dir = profileDir(profile);
  try {
    ensureProfileDirs(profile, env.data);
    // `; exit` ends the session when the login finishes — the watcher reaps it.
    const command = `${buildRuntimeCommand({ command: rc.login_command, idle_pattern: '' }, { env: env.data })}; exit`;
    tmux.newSession(session, dir, command);
  } catch (e) {
    return { ok: false, code: 'failed', error: `Failed to open login seat: ${(e as Error).message}` };
  }

  const inserted = insertAgent({
    name: `login-${profile}-${runtime}`,
    runtime,
    tmux_session: session,
    workspace: dir,
    mode: 'adopted',
    status: 'idle',
    profile,
  });
  if (!inserted.ok) {
    tmux.killSession(session);
    return { ok: false, code: 'failed', error: inserted.error };
  }

  const expiresAt = new Date(Date.now() + LOGIN_SEAT_TTL_MS).toISOString();
  setAgentLease(inserted.data.id, { owner_id: user.id, reason: 'reserved', expires_at: expiresAt });

  const deadline = Date.now() + LOGIN_SEAT_TTL_MS;
  const timer = setInterval(() => checkLoginSeat(inserted.data.id), LOGIN_SEAT_POLL_MS);
  timer.unref?.();
  watches.set(inserted.data.id, { agentId: inserted.data.id, session, profile, runtime, deadline, timer });

  emit('profile.login_started', 'agent', inserted.data.id, { profile, runtime, session, expires_at: expiresAt });
  logger.info({ agentId: inserted.data.id, profile, runtime }, 'Login seat opened');

  const fresh = getAgent(inserted.data.id);
  return { ok: true, data: { agent: fresh.ok ? fresh.data : inserted.data, session, expires_at: expiresAt } };
}

/** Watcher tick: reap on exit, kill after the TTL. Exported for tests. */
export function checkLoginSeat(agentId: string, now = Date.now()): 'open' | 'exited' | 'timeout' | 'unknown' {
  const watch = watches.get(agentId);
  if (!watch) return 'unknown';
  if (!tmux.hasSession(watch.session)) {
    closeLoginSeat(agentId, 'exited');
    return 'exited';
  }
  if (now >= watch.deadline) {
    closeLoginSeat(agentId, 'timeout');
    return 'timeout';
  }
  return 'open';
}

/** Kill the session (if still up), drop the agent record, report credential presence. */
export function closeLoginSeat(agentId: string, reason: 'exited' | 'timeout' | 'replaced' | 'orphaned'): void {
  const watch = watches.get(agentId);
  if (watch) {
    clearInterval(watch.timer);
    watches.delete(agentId);
  }
  const agent = getAgent(agentId);
  if (!agent.ok) return;

  // Dynamic: output-watcher → task-dispatcher → login-seats would be a cycle.
  void import('./output-watcher.js').then((ow) => ow.stopWatching(agentId)).catch(() => undefined);
  if (tmux.hasSession(agent.data.tmux_session)) tmux.killSession(agent.data.tmux_session);
  deleteAgent(agentId);

  const profile = agent.data.profile ?? watch?.profile ?? null;
  const runtime = agent.data.runtime;
  const status = profile ? profileStatuses().find((p) => p.name === profile) : undefined;
  emit('profile.login_finished', 'agent', agentId, {
    profile,
    runtime,
    reason,
    logged_in: status?.runtimes[runtime]?.logged_in ?? false,
  }, null);
  logger.info({ agentId, profile, runtime, reason }, 'Login seat closed');
}

/** Health-monitor tick: reap seats nobody is watching (lost on restart) once they exit or expire. */
export function sweepLoginSeats(agents: Agent[], now = Date.now()): string[] {
  const reaped: string[] = [];
  for (const agent of agents) {
    if (!isLoginSeat(agent) || watches.has(agent.id)) continue;
    const expired = agent.lease_expires_at ? Date.parse(agent.lease_expires_at) <= now : true;
    if (!tmux.hasSession(agent.tmux_session) || expired) {
      closeLoginSeat(agent.id, 'orphaned');
      reaped.push(agent.id);
    }
  }
  return reaped;
}

export function resetLoginSeatsForTest(): void {
  for (const w of watches.values()) clearInterval(w.timer);
  watches.clear();
}
