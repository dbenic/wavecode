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

export interface LoginHint {
  /** the sign-in link the CLI printed (joined across wrapped lines, OSC codes removed) */
  url: string | null;
  /** a one-time device code the CLI printed (Codex style ABCD-EFGHI) */
  code: string | null;
  /** the CLI waits for a code the browser shows ("Paste code here if prompted") */
  awaiting_code: boolean;
  /** last meaningful lines of the pane, for the person */
  tail: string[];
}

/** Pull link, code and state out of a login pane text (exported for tests). */
export function parseLoginPane(text: string): LoginHint {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const urls = joinWrappedUrls(clean).map((u) => u.replace(/[.,;)]+$/, ''));
  // prefer the sign-in link over anything else the CLI printed
  const url = urls.find((u) => /auth|oauth|device|login|sign/i.test(u)) ?? urls[urls.length - 1] ?? null;
  const code = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1] ?? null;
  const awaiting = /paste code here|enter the code|authorization code/i.test(clean);
  const tail = clean.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !/^[\s*░▓█▄.]+$/.test(l)).slice(-8);
  return { url, code, awaiting_code: awaiting, tail };
}

/**
 * The CLI prints a long OAuth link over several rows (its own line breaks, so
 * tmux -J cannot join them): a line that starts a URL continues while the
 * following lines consist of URL characters only.
 */
function joinWrappedUrls(clean: string): string[] {
  const lines = clean.split('\n').map((l) => l.trim());
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/https?:\/\/[^\s"'<>\\\]]+/);
    if (!m) continue;
    let url = m[0];
    // continuation rows: no spaces, URL charset, and the row before was filled to its end by the URL
    while (i + 1 < lines.length && lines[i].endsWith(url.slice(-8)) && /^[A-Za-z0-9%._~:/?#@!$&'()*+,;=-]+$/.test(lines[i + 1])) {
      url += lines[i + 1];
      i++;
    }
    out.push(url);
  }
  return out;
}

/**
 * First-run screens Claude Code shows before the sign-in link. The watcher
 * answers them so the seat reaches the link by itself (exported for tests):
 * the theme picker takes Enter, the login-method menu takes option 1
 * (Claude account with subscription — the only kind a profile may use).
 */
export function loginAutoAdvanceKey(paneText: string): 'Enter' | null {
  if (/Select login method/i.test(paneText) && /❯\s*1\.\s*Claude account/i.test(paneText)) return 'Enter';
  // "Login successful" / "Security notes" screens after the code was accepted
  if (/Press Enter to continue/i.test(paneText.split('\n').filter((l) => l.trim()).slice(-4).join('\n'))) return 'Enter';
  // the workspace trust check on the profile dir: "No, exit" is preselected — exiting ends the seat, logged in
  if (/Yes,\s*I trust this folder/i.test(paneText) && /❯\s*No,\s*exit/i.test(paneText)) return 'Enter';
  // the theme picker prints no "Enter to confirm" hint; the preselected dark theme is fine for a seat
  if (/Choose the text style|Select a theme|run \/theme/i.test(paneText) && /Dark mode|Light mode/i.test(paneText) && !/Select login method/i.test(paneText)) return 'Enter';
  return null;
}

/** The hint for an open login seat, or null when the seat is gone. */
export function loginHint(agentId: string): LoginHint | null {
  const agent = getAgent(agentId);
  if (!agent.ok || !isLoginSeat(agent.data)) return null;
  const cap = tmux.capturePaneJoined(agent.data.tmux_session, 60);
  if (!cap.ok) return null;
  return parseLoginPane(cap.data);
}

/** Type the code the browser showed into the seat (Claude's "Paste code here"). */
export function submitLoginCode(agentId: string, code: string): LoginSeatResult<void> {
  const agent = getAgent(agentId);
  if (!agent.ok || !isLoginSeat(agent.data)) return { ok: false, error: 'No open login for that profile and runtime', code: 'invalid' };
  const clean = code.trim();
  if (!/^[A-Za-z0-9_#.-]{4,200}$/.test(clean)) return { ok: false, error: 'That does not look like a login code', code: 'invalid' };
  try {
    tmux.sendTextAndEnter(agent.data.tmux_session, clean, { mode: 'type' });
  } catch (e) {
    return { ok: false, error: (e as Error).message, code: 'failed' };
  }
  return { ok: true, data: undefined };
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
  const cap = tmux.capturePaneJoined(watch.session, 40);
  if (cap.ok) {
    const key = loginAutoAdvanceKey(cap.data);
    if (key) {
      try { tmux.sendRawKey(watch.session, key); } catch { /* the seat may have just exited */ }
    }
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
      continue;
    }
    // still open and within its lease (a daemon restart lost the watcher): watch it again
    const m = agent.name.match(/^login-(.+?)-(claude-code|codex|grok|aider|[a-z0-9-]+)$/);
    const profile = agent.profile ?? m?.[1] ?? '';
    const runtime = agent.runtime;
    const deadline = Date.parse(agent.lease_expires_at!);
    const timer = setInterval(() => checkLoginSeat(agent.id), LOGIN_SEAT_POLL_MS);
    timer.unref?.();
    watches.set(agent.id, { agentId: agent.id, session: agent.tmux_session, profile, runtime, deadline, timer });
    logger.info({ agentId: agent.id, profile, runtime }, 'Login seat re-watched after restart');
  }
  return reaped;
}

export function resetLoginSeatsForTest(): void {
  for (const w of watches.values()) clearInterval(w.timer);
  watches.clear();
}
