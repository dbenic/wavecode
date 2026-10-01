/**
 * Runtime liveness (multi-orchestrator spec §6 T0).
 *
 * A tmux seat can outlive its runtime: when Claude/Codex/Grok exits, the
 * pane drops back to the login shell, and a prompt typed via send-keys is
 * then executed by bash line by line. Before dispatching (and on every
 * health-monitor tick) we look at the pane; a bare shell prompt on the last
 * line means the TUI is gone, so the configured runtime command is relaunched
 * in the same session and we wait for the pane to leave the prompt.
 */

import { getConfig } from './config.js';
import type { Agent, Result } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { buildLaunchCommand } from './runtime-launcher.js';
import * as tmux from './tmux.js';

export const RUNTIME_SETTLE_TIMEOUT_MS = 30_000;
export const RUNTIME_SETTLE_POLL_MS = 1_000;
/** Consecutive non-shell captures required before a relaunch counts as settled. */
const SETTLE_CHECKS = 2;

export const RUNTIME_NOT_RUNNING = 'runtime not running';

/**
 * Shell prompts that end a pane with nothing typed after them:
 *   user@host:~/repo$   root@box:/srv#   (venv) user@host:~$
 *   bash-5.2$   $   #   user@host ~ %
 * A command echoed after the prompt (`user@host:~$ claude`) is NOT bare —
 * that is the relaunch in progress. Deliberately conservative: a false
 * positive would type the runtime command into a live TUI as a prompt, so
 * glyph-only prompts (❯, ➜, >) that TUIs also use are not matched.
 */
const BARE_SHELL_PATTERNS: RegExp[] = [
  /^(\([^)]*\)\s*)?[\w.-]+@[\w.-]+:[^\s]*\s?[$#]\s?$/,   // bash user@host:path$
  /^(\([^)]*\)\s*)?[\w.-]+@[\w.-]+\s+\S+\s?[%$#]\s?$/,    // zsh user@host dir %
  /^(ba|z|k)?sh(-[\d.]+)?[$#]\s?$/,                        // bash-5.2$
  /^[$#]\s?$/,                                             // bare $ / #
];

/** True when the last non-empty pane line is a bare shell prompt. */
export function isBareShellPrompt(paneText: string): boolean {
  const lines = paneText.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const trimmed = line.trim();
    return BARE_SHELL_PATTERNS.some((re) => re.test(trimmed));
  }
  return false;
}

export type RuntimeState = 'alive' | 'dead' | 'unknown';

/** Inspect the pane. `unknown` = no session / capture failed (not our call to relaunch). */
export function getRuntimeState(agent: Pick<Agent, 'tmux_session'>): RuntimeState {
  if (!tmux.hasSession(agent.tmux_session)) return 'unknown';
  const capture = tmux.capturePane(agent.tmux_session, 20);
  if (!capture.ok) return 'unknown';
  return isBareShellPrompt(capture.data) ? 'dead' : 'alive';
}

/** agent id → epoch ms a relaunch was sent (dispatcher and monitor share it). */
const relaunchedAt = new Map<string, number>();

/**
 * Consecutive relaunches sent without the runtime ever settling. A command
 * that fails fast (binary missing, bad flag) returns the pane to the prompt
 * every tick; without a cap the monitor would retype it forever.
 */
export const MAX_RELAUNCH_ATTEMPTS = 3;
const relaunchAttempts = new Map<string, number>();

export function resetRuntimeLivenessForTest(): void {
  relaunchedAt.clear();
  relaunchAttempts.clear();
}

/** Called whenever the runtime is observed alive — clears the attempt budget. */
export function noteRuntimeAlive(agentId: string): void {
  relaunchAttempts.delete(agentId);
}

export function relaunchAttemptsExhausted(agentId: string): boolean {
  return (relaunchAttempts.get(agentId) ?? 0) >= MAX_RELAUNCH_ATTEMPTS;
}

/**
 * Type the agent's configured runtime command (with its model/effort pin)
 * into the existing session. Skips if a relaunch was sent within the settle
 * window, so the monitor tick and a dispatch never double-launch. Refuses
 * once MAX_RELAUNCH_ATTEMPTS were sent without the runtime coming back.
 */
export function relaunchRuntime(agent: Agent, reason: 'dispatch' | 'health_check' | 'manual'): Result<{ sent: boolean }> {
  const last = relaunchedAt.get(agent.id);
  if (last !== undefined && Date.now() - last < RUNTIME_SETTLE_TIMEOUT_MS) {
    return { ok: true, data: { sent: false } };
  }

  const attempts = relaunchAttempts.get(agent.id) ?? 0;
  if (attempts >= MAX_RELAUNCH_ATTEMPTS) {
    return { ok: false, error: `runtime relaunch attempts exhausted (${attempts}) — check the runtime command for '${agent.runtime}'` };
  }

  // Same command as spawn, including the agent's credential profile env
  const command = buildLaunchCommand(agent.runtime, { model: agent.model, effort: agent.effort, profile: agent.profile });
  if (!command.ok) return command;
  try {
    tmux.sendTextAndEnter(agent.tmux_session, command.data);
  } catch (e) {
    return { ok: false, error: `Failed to relaunch runtime: ${(e as Error).message}` };
  }

  relaunchedAt.set(agent.id, Date.now());
  relaunchAttempts.set(agent.id, attempts + 1);
  emit('agent.runtime_relaunched', 'agent', agent.id, {
    name: agent.name,
    runtime: agent.runtime,
    model: agent.model,
    effort: agent.effort,
    reason,
  });
  logger.warn({ agentId: agent.id, runtime: agent.runtime, reason }, 'Runtime TUI had exited — relaunched');
  return { ok: true, data: { sent: true } };
}

/** Poll until the pane has left the shell prompt for SETTLE_CHECKS captures in a row. */
export async function waitForRuntimeSettled(
  agent: Pick<Agent, 'tmux_session'>,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? RUNTIME_SETTLE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? RUNTIME_SETTLE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let streak = 0;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const state = getRuntimeState(agent);
    streak = state === 'alive' ? streak + 1 : 0;
    if (streak >= SETTLE_CHECKS) return true;
  }
  return false;
}

/**
 * Dispatch gate: alive → ok; bare shell → relaunch, wait to settle, ok;
 * never settles → `runtime not running`. A pane we cannot inspect is left
 * to the existing send-keys error handling.
 */
export async function ensureRuntimeAlive(
  agent: Agent,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Result<{ relaunched: boolean }>> {
  if (getRuntimeState(agent) !== 'dead') return { ok: true, data: { relaunched: false } };

  const relaunch = relaunchRuntime(agent, 'dispatch');
  if (!relaunch.ok) {
    logger.warn({ agentId: agent.id, error: relaunch.error }, 'Runtime relaunch failed');
    return { ok: false, error: RUNTIME_NOT_RUNNING };
  }

  const settled = await waitForRuntimeSettled(agent, opts);
  if (!settled) return { ok: false, error: RUNTIME_NOT_RUNNING };
  relaunchedAt.delete(agent.id);
  return { ok: true, data: { relaunched: true } };
}
