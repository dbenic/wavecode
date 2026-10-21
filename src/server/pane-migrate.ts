/**
 * Move existing agent panes off the alternate screen.
 *
 * tmux keeps no scrollback for a pane while it is on the alternate screen,
 * and a pane that entered it keeps that state across a relaunch of the TUI
 * inside it. Only a new pane starts clean. For each idle agent whose pane is
 * still on the alternate screen, the pane is respawned (tmux respawn-pane
 * -k: same session, same window, a fresh pane at a shell prompt); the
 * runtime relaunch then brings the CLI back resuming its conversation
 * (--continue for Claude, the worktree's own thread for Codex). Working
 * agents are left alone and picked up on a later pass.
 */

import { listAgents, type Agent } from './db.js';
import { emit } from './event-bus.js';
import { isLoginSeat } from './login-seats.js';
import logger from './logger.js';
import { relaunchRuntime } from './runtime-liveness.js';
import * as tmux from './tmux.js';

export const MIGRATE_EVERY_MS = 5 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;

/** One pass. Returns the names of the agents whose panes were recreated. Exported for tests. */
export async function migrateAlternateScreenPanes(): Promise<string[]> {
  const done: string[] = [];
  for (const agent of listAgents()) {
    if (isLoginSeat(agent) || agent.status !== 'idle') continue;
    if (!(await tmux.hasSession(agent.tmux_session))) continue;
    const alt = (await tmux.tmuxExecSafe(['display-message', '-t', agent.tmux_session, '-p', '#{alternate_on}']))?.trim();
    if (alt !== '1') continue;
    const ok = await tmux.respawnPane(agent.tmux_session);
    if (!ok) { logger.warn({ agentId: agent.id, name: agent.name }, 'Pane respawn failed'); continue; }
    await tmux.disableAlternateScreen(agent.tmux_session);
    const relaunch = await relaunchRuntime(agent as Agent, 'manual');
    logger.info({ agentId: agent.id, name: agent.name, relaunched: relaunch.ok }, 'Pane recreated off the alternate screen');
    emit('agent.pane_recreated', 'agent', agent.id, { name: agent.name, reason: 'scrollback', relaunched: relaunch.ok }, null);
    done.push(agent.name);
  }
  return done;
}

export function startPaneMigration(): void {
  if (timer) return;
  const run = () => { void migrateAlternateScreenPanes().catch((e) => logger.warn({ error: (e as Error).message }, 'Pane migration pass failed')); };
  firstRun = setTimeout(run, 45_000);
  firstRun.unref?.();
  timer = setInterval(run, MIGRATE_EVERY_MS);
  timer.unref?.();
}

export function stopPaneMigration(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}
