/**
 * The orchestrator (PM) seat (spec §5b). One agent is the Command Center's
 * default recipient: `config.orchestrator_agent` by name, else the first
 * agent with `role = 'orchestrator'`, else an agent named `pm` or
 * `orchestrator`. A seat spawned/adopted with role orchestrator (or set to
 * it later) is sent the standing operating prompt in
 * docs/orchestrator-seat.md once its runtime is up.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { AGENT_ROLES, getAgent, type Agent, type AgentRole, type Result } from './db.js';
import { emit } from './event-bus.js';
import { isFileRunnerSeat } from './file-runner.js';
import logger from './logger.js';
import { trackPrompt } from './reply-capture.js';
import { roomsBriefLine } from './rooms.js';
import { feedbackBriefLine } from './feedback.js';
import { getRuntimeState, waitForRuntimeSettled } from './runtime-liveness.js';
import * as sessionManager from './session-manager.js';
import { isClaudeBypassAcceptDialog } from './output-watcher.js';
import { fileURLToPath } from 'node:url';

export const ORCHESTRATOR_BRIEF_PATH = path.join('docs', 'orchestrator-seat.md');
/** Package root (works from src/server and dist/server alike), independent of cwd. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FALLBACK_NAMES = ['pm', 'orchestrator'];

/** Which agent the composer targets by default, or null. */
export function resolveOrchestratorAgent(agents: Agent[], configuredName?: string | null): Agent | null {
  const configured = configuredName === undefined ? configuredOrchestratorName() : configuredName;
  if (configured) {
    const byName = agents.find((a) => a.name === configured || a.id === configured);
    if (byName) return byName;
  }
  const byRole = agents.find((a) => a.role === 'orchestrator');
  if (byRole) return byRole;
  for (const name of FALLBACK_NAMES) {
    const match = agents.find((a) => a.name === name);
    if (match) return match;
  }
  return null;
}

function configuredOrchestratorName(): string | null {
  try {
    return getConfig().orchestrator_agent ?? null;
  } catch {
    return null; // config not loaded (tests / embedded use)
  }
}

/** `role` from a request body: undefined = leave as is; null clears; only 'orchestrator' is valid. */
export function parseAgentRole(value: unknown): { ok: true; role: AgentRole | null | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, role: undefined };
  if (value === null) return { ok: true, role: null };
  if (typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value)) return { ok: true, role: value as AgentRole };
  return { ok: false, error: `role must be one of: ${AGENT_ROLES.join(', ')} (or null)` };
}

/**
 * The operating prompt as ONE line: a literal newline typed into a TUI
 * submits early, so the markdown is flattened (headings dropped, list items
 * and paragraphs joined).
 */
export function buildOrchestratorBrief(root: string = PACKAGE_ROOT, extra?: string | null): string {
  let md: string;
  try {
    md = fs.readFileSync(path.join(root, ORCHESTRATOR_BRIEF_PATH), 'utf8');
  } catch {
    logger.warn({ root }, 'docs/orchestrator-seat.md not found — using the inline fallback brief');
    md = 'You are the WaveCode orchestrator seat (the team PM). Answer status questions in plain prose from list_agents/list_tasks/get_agent_output; '
      + 'end a message that needs a decision with ONE question and 2-4 options on their own lines prefixed "[ ]"; '
      + 'carry decisions out with the tools and report each step; never claim a result without a RESULT/verdict.';
  }
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, '• '))
    .concat(extra ? [extra] : [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `user@host:path$ claude --model x` — the launch command echoed, runtime not up yet. */
const LAUNCH_ECHO = /[\w.-]+@[\w.-]+(?::[^\s]*|\s+\S+)\s?[$#%]\s+\S/;

/**
 * True when the pane shows a runtime TUI that is idle and not sitting on a
 * first-run dialog. Exported for tests.
 */
export function isSeatReady(agent: Pick<Agent, 'tmux_session'>, pane: string): boolean {
  if (getRuntimeState(agent) !== 'alive') return false;
  const lines = pane.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const last = lines[lines.length - 1] ?? '';
  if (LAUNCH_ECHO.test(last)) return false;
  if (isClaudeBypassAcceptDialog(pane)) return false;
  if (/trust this folder|Yes, I trust|Enter to confirm/i.test(pane)) return false;
  return true;
}

async function waitForSeatReady(
  agent: Agent,
  opts: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = sessionManager.capturePane(agent.tmux_session, 40);
    if (pane.ok && isSeatReady(agent, pane.data)) return true;
    if (Date.now() >= deadline) return false;
    // A bare shell means the runtime exited — let the liveness layer relaunch it
    if (getRuntimeState(agent) === 'dead') {
      const settled = await waitForRuntimeSettled(agent, { timeoutMs: Math.max(0, deadline - Date.now()), pollMs });
      if (!settled) return false;
      continue;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Send the operating prompt to an orchestrator seat. Waits for a freshly
 * launched runtime to come up idle and dialog-free (never types into a bare
 * shell or a launching process). The seat's acknowledgement is captured as
 * its first reply.
 */
export async function briefOrchestratorSeat(
  agentId: string,
  actorId: string | null,
  /** `extra`: seat-specific instructions appended to the brief (spec §5d: the user's rules + SEAT.md). */
  opts: { timeoutMs?: number; pollMs?: number; extra?: string | null } = {},
): Promise<Result<void>> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return agentResult;
  const agent = agentResult.data;
  if (isFileRunnerSeat(agent)) return { ok: false, error: 'File-runner seats cannot hold the orchestrator role' };

  // A freshly spawned seat is NOT ready just because the pane is no longer a
  // bare shell: right after spawn it shows the launch command being typed,
  // then possibly a first-run dialog. Typing the brief then loses it (or
  // answers the dialog). Wait for an idle, dialog-free TUI.
  const ready = await waitForSeatReady(agent, opts);
  if (!ready) {
    logger.warn({ agentId }, 'Orchestrator brief not sent — runtime did not come up idle');
    return { ok: false, error: 'runtime not running' };
  }

  // Spec §5e: every seat learns where the project rooms are and to keep ROOM.md current
  // Spec §5f: the seat's next session starts from the feedback its answers got
  const brief = buildOrchestratorBrief(undefined, [roomsBriefLine(), feedbackBriefLine(agent.id), opts.extra].filter(Boolean).join(' ') || null);
  const sent = sessionManager.sendKeys(agent.id, brief);
  if (!sent.ok) return { ok: false, error: sent.error };

  const event = emit('agent.prompt_sent', 'agent', agent.id, { text: brief.slice(0, 2000), via: 'orchestrator_brief' }, actorId);
  trackPrompt({ agent, actorId, prompt: brief, promptEventId: event?.id ?? null, quietIfSuperseded: true });
  emit('agent.orchestrator_briefed', 'agent', agent.id, { name: agent.name }, actorId);
  logger.info({ agentId, name: agent.name }, 'Orchestrator seat briefed');
  return { ok: true, data: undefined };
}
