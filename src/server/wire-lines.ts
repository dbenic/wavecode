/**
 * Agent-to-agent messages for CLIs without MCP (Codex, Grok, plain Claude):
 * the agent prints one line, WaveCode delivers.
 *
 *   TO @claude1: please review /home/wave/inbox/spec.md and answer with VERDICT: PASS|NEEDS FIXES
 *
 * The output watcher calls detectWireLines() on idle ticks. Each new TO line
 * becomes a persisted message (from → to, type handoff) that shows in the
 * thread, and is typed into the recipient's pane as
 * `[Message from @codex1] …` as soon as that agent is idle. Deduplicated per
 * sender so a line that stays on screen fires once. Unknown recipients are
 * reported back to the sender. (ASK peer/agent lines are handled in peers.ts.)
 */

import { createHash } from 'node:crypto';
import { getAgent, insertAgentMessage, resolveAgent, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import * as sessionManager from './session-manager.js';

const TO_LINE_RE = /^[\s•>›⏺*-]*TO\s+@?([\w.-]{1,64}):\s*(.{3,})$/;
const SCAN_LINES = 80;
const MAX_MESSAGE_CHARS = 4000;
/** The example in docs/agent-operating-rules.md never fires. */
const RULES_EXAMPLE = 'please review /home/wave/inbox/spec.md and answer with VERDICT: PASS|NEEDS FIXES';

const seen = new Map<string, Set<string>>();           // senderId → hashes already delivered
const pending = new Map<string, string[]>();            // recipientId → texts waiting for an idle pane

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function detectWireLines(senderId: string, output: string): void {
  const sender = getAgent(senderId);
  if (!sender.ok) return;
  const lines = stripAnsi(output).split('\n').slice(-SCAN_LINES);
  for (const raw of lines) {
    const m = TO_LINE_RE.exec(raw.trimEnd());
    if (!m) continue;
    const [, handle, bodyRaw] = m;
    const body = bodyRaw.trim().substring(0, MAX_MESSAGE_CHARS);
    if (body === RULES_EXAMPLE) continue;
    const key = createHash('sha1').update(`${handle}:${body}`).digest('hex');
    const set = seen.get(senderId) ?? new Set<string>();
    if (set.has(key)) continue;
    set.add(key);
    seen.set(senderId, set);
    handOff(sender.data, handle, body);
  }
}

function handOff(sender: Agent, handle: string, body: string): void {
  const target = resolveAgent(handle);
  if (!target.ok) {
    sessionManager.sendKeys(sender.id, `[TO @${handle} failed: no such agent — use an alias or name from the roster]`);
    return;
  }
  if (target.data.id === sender.id) return;
  const stored = insertAgentMessage({
    from_agent_id: sender.id,
    to_agent_id: target.data.id,
    workspace: target.data.workspace ?? null,
    message: body,
    message_type: 'handoff',
  });
  if (!stored.ok) {
    logger.warn({ from: sender.id, to: target.data.id, error: stored.error }, 'TO line: message not stored');
    return;
  }
  emit('message.created', 'agent_message', stored.data.id, {
    from_agent_id: sender.id,
    to_agent_id: target.data.id,
    message_type: 'handoff',
    via: 'wire_line',
  }, null);
  const text = `[Message from @${sender.alias ?? sender.name}] ${body}`;
  if (target.data.status === 'working') {
    const list = pending.get(target.data.id) ?? [];
    list.push(text);
    pending.set(target.data.id, list);
    return;
  }
  deliver(target.data, text);
}

function deliver(agent: Agent, text: string): void {
  const sent = sessionManager.sendKeys(agent.id, text);
  if (!sent.ok) logger.warn({ agentId: agent.id, error: sent.error }, 'TO line: could not type the message into the recipient');
}

/**
 * A line from WaveCode itself (not from another agent): persisted as a message
 * so the thread shows it, typed into the pane when the agent is idle. Used by
 * the hand-off folder watcher.
 */
export function deliverSystemLine(agent: Agent, text: string, opts: { kind?: 'handoff' | 'info'; source?: string } = {}): void {
  const stored = insertAgentMessage({ from_agent_id: null, to_agent_id: agent.id, workspace: agent.workspace ?? null, message: text, message_type: opts.kind ?? 'info' });
  if (stored.ok) {
    emit('message.created', 'agent_message', stored.data.id, { from_agent_id: null, to_agent_id: agent.id, message_type: opts.kind ?? 'info', via: 'system', source: opts.source ?? null }, null);
  }
  const fresh = getAgent(agent.id);
  const target = fresh.ok ? fresh.data : agent;
  if (target.status === 'working') {
    const list = pending.get(target.id) ?? [];
    list.push(text);
    pending.set(target.id, list);
    return;
  }
  deliver(target, text);
}

/** Output-watcher hook: the recipient went idle — deliver what waited for it. */
export function onAgentIdle(agentId: string): void {
  const list = pending.get(agentId);
  if (!list?.length) return;
  pending.delete(agentId);
  const agent = getAgent(agentId);
  if (!agent.ok) return;
  for (const text of list) deliver(agent.data, text);
}

export function resetWireLinesForTest(): void {
  seen.clear();
  pending.clear();
}
