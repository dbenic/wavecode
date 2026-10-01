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
import { getRuntimeState, waitForRuntimeSettled } from './runtime-liveness.js';
import * as sessionManager from './session-manager.js';

export const ORCHESTRATOR_BRIEF_PATH = path.join('docs', 'orchestrator-seat.md');
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
export function buildOrchestratorBrief(root: string = process.cwd()): string {
  let md: string;
  try {
    md = fs.readFileSync(path.join(root, ORCHESTRATOR_BRIEF_PATH), 'utf8');
  } catch {
    md = 'You are the WaveCode orchestrator seat (the team PM). Answer status questions in plain prose from list_agents/list_tasks/get_agent_output; '
      + 'end a message that needs a decision with ONE question and 2-4 options on their own lines prefixed "[ ]"; '
      + 'carry decisions out with the tools and report each step; never claim a result without a RESULT/verdict.';
  }
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, '• '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Send the operating prompt to an orchestrator seat. Waits for a freshly
 * launched runtime to come up (never types into a bare shell). The seat's
 * acknowledgement is captured as its first reply.
 */
export async function briefOrchestratorSeat(
  agentId: string,
  actorId: string | null,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Result<void>> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return agentResult;
  const agent = agentResult.data;
  if (isFileRunnerSeat(agent)) return { ok: false, error: 'File-runner seats cannot hold the orchestrator role' };

  if (getRuntimeState(agent) !== 'alive') {
    const settled = await waitForRuntimeSettled(agent, opts);
    if (!settled) {
      logger.warn({ agentId }, 'Orchestrator brief not sent — runtime did not come up');
      return { ok: false, error: 'runtime not running' };
    }
  }

  const brief = buildOrchestratorBrief();
  const sent = sessionManager.sendKeys(agent.id, brief);
  if (!sent.ok) return { ok: false, error: sent.error };

  const event = emit('agent.prompt_sent', 'agent', agent.id, { text: brief.slice(0, 2000), via: 'orchestrator_brief' }, actorId);
  trackPrompt({ agent, actorId, prompt: brief, promptEventId: event?.id ?? null });
  emit('agent.orchestrator_briefed', 'agent', agent.id, { name: agent.name }, actorId);
  logger.info({ agentId, name: agent.name }, 'Orchestrator seat briefed');
  return { ok: true, data: undefined };
}
