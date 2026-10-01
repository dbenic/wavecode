/**
 * Reply capture (spec §5b): what an agent *says* lands in the thread.
 *
 * Every prompt typed into a tmux agent (POST /api/agents/:id/send, MCP
 * send_prompt via that route, reply injection from /api/messages) records a
 * pending reply. When the agent goes idle again, the pane is captured, the
 * runtime's chrome stripped (reply-extractors.ts) and the final prose stored
 * as an `agent_messages` row of type `reply`, emitted as `message.created`.
 * If no idle arrives within 10 minutes, whatever is there is posted with
 * `truncated: true` — never silence.
 *
 * One pending reply per agent: a newer prompt supersedes an older one (the
 * TUI answers queued prompts in order, and the newest echo anchors the
 * capture).
 */

import {
  getAgent,
  getRun,
  getTask,
  insertAgentMessage,
  listOpenRuns,
  updateRunSummary,
  type Agent,
} from './db.js';
import { emit } from './event-bus.js';
import { isFileRunnerSeat } from './file-runner.js';
import logger from './logger.js';
import { extractReply } from './reply-extractors.js';
import { capturePane } from './session-manager.js';

export const REPLY_TIMEOUT_MS = 10 * 60_000;
/** An idle pane that has not changed for a tick, this long after the send, may hold a fast answer. */
export const QUIET_RESOLVE_MS = 6_000;
const CAPTURE_LINES = 500;
const PROMPT_EXCERPT_CHARS = 2000;

export interface PendingReply {
  agentId: string;
  actorId: string | null;
  prompt: string;
  promptEventId: number | null;
  taskId: string | null;
  sentAt: number;
}

const pending = new Map<string, PendingReply>();

export function resetReplyCaptureForTest(): void {
  pending.clear();
}

export function getPendingReply(agentId: string): PendingReply | undefined {
  return pending.get(agentId);
}

function isLoginSeat(agent: Pick<Agent, 'tmux_session'>): boolean {
  return agent.tmux_session.startsWith('wc-login-');
}

/** Record that `prompt` was just typed into `agent`. No-op for seats without a pane. */
export function trackPrompt(opts: {
  agent: Agent;
  actorId: string | null;
  prompt: string;
  promptEventId?: number | null;
  now?: number;
}): void {
  const { agent } = opts;
  if (isFileRunnerSeat(agent) || isLoginSeat(agent)) return;
  const open = listOpenRuns(agent.id)[0];
  pending.set(agent.id, {
    agentId: agent.id,
    actorId: opts.actorId,
    prompt: opts.prompt.slice(0, PROMPT_EXCERPT_CHARS),
    promptEventId: opts.promptEventId ?? null,
    taskId: open?.task_id ?? null,
    sentAt: opts.now ?? Date.now(),
  });
}

function capture(agent: Agent): string | null {
  const res = capturePane(agent.tmux_session, CAPTURE_LINES);
  return res.ok ? res.data : null;
}

function persist(p: PendingReply, agent: Agent, text: string, truncated: boolean): void {
  pending.delete(p.agentId);
  const inserted = insertAgentMessage({
    from_agent_id: agent.id,
    to_agent_id: null,
    workspace: agent.workspace,
    message: text,
    message_type: 'reply',
    ref_task_id: p.taskId,
    ref_prompt_actor: p.actorId,
    ref_prompt_event_id: p.promptEventId,
    truncated,
  });
  if (!inserted.ok) {
    logger.warn({ agentId: agent.id, error: inserted.error }, 'Failed to store captured reply');
    return;
  }
  emit('message.created', 'agent_message', inserted.data.id, {
    from_agent_id: agent.id,
    to_agent_id: null,
    message_type: 'reply',
    ref_prompt_actor: p.actorId,
    ref_prompt_event_id: p.promptEventId,
    ref_task_id: p.taskId,
    truncated,
  }, null);
}

/**
 * Output-watcher hook, called on every tick where the agent looks idle.
 * `transitioned` = this tick is the working → idle edge. Without the edge
 * (a fast answer can finish between two 2s polls), a quiet pane a few
 * seconds after the send resolves too — but only when the prompt echo is
 * found and an answer follows it.
 */
export function onAgentIdle(
  agentId: string,
  opts: { transitioned: boolean; outputChanged: boolean; now?: number },
): boolean {
  const p = pending.get(agentId);
  if (!p) return false;
  const now = opts.now ?? Date.now();
  if (!opts.transitioned && (opts.outputChanged || now - p.sentAt < QUIET_RESOLVE_MS)) return false;

  const agentResult = getAgent(agentId);
  if (!agentResult.ok) {
    pending.delete(agentId);
    return false;
  }
  const pane = capture(agentResult.data);
  if (pane === null) return false;

  const reply = extractReply(agentResult.data.runtime, pane, p.prompt);
  if (!reply.text) return false; // nothing yet — keep waiting (the 10-minute fallback still applies)
  if (!opts.transitioned && !reply.anchored) return false;

  persist(p, agentResult.data, reply.text, false);
  return true;
}

/** Health-monitor tick: post whatever was captured for replies older than 10 minutes. */
export function sweepExpiredReplies(now = Date.now()): string[] {
  const posted: string[] = [];
  for (const p of [...pending.values()]) {
    if (now - p.sentAt < REPLY_TIMEOUT_MS) continue;
    const agentResult = getAgent(p.agentId);
    if (!agentResult.ok) {
      pending.delete(p.agentId);
      continue;
    }
    const pane = capture(agentResult.data);
    const text = pane ? extractReply(agentResult.data.runtime, pane, p.prompt).text : '';
    persist(p, agentResult.data, text || '(no reply captured within 10 minutes — open the agent to see its pane)', true);
    posted.push(p.agentId);
  }
  return posted;
}

/**
 * At run completion, store the run's prose summary (same extractor) on the
 * run so its thread item can answer "what did it do" without the pane.
 * Anchored on the task prompt when its echo is visible.
 */
export function captureRunSummary(runId: string, agentId: string): string | null {
  try {
    const agentResult = getAgent(agentId);
    if (!agentResult.ok || isFileRunnerSeat(agentResult.data)) return null;
    const run = getRun(runId);
    if (!run.ok) return null;
    const pane = capture(agentResult.data);
    if (!pane) return null;
    const task = getTask(run.data.task_id);
    const summary = extractReply(agentResult.data.runtime, pane, task.ok ? task.data.prompt : null).text;
    if (!summary) return null;
    updateRunSummary(runId, summary);
    // The run's own reply supersedes a pending chat reply anchored to the same work.
    const p = pending.get(agentId);
    if (p && p.taskId === run.data.task_id) pending.delete(agentId);
    return summary;
  } catch (e) {
    logger.debug({ runId, agentId, error: (e as Error).message }, 'Run summary capture skipped');
    return null;
  }
}

// --- quick replies -------------------------------------------------------------

export interface ReplyQuestion {
  /** True when the reply ends with a question (options aside). */
  asks: boolean;
  /** 2–4 options from trailing `[ ] option` lines (or a `[A] [B]` chip line). */
  options: string[];
}

const OPTION_LINE_RE = /^\s*(?:[-*]\s+)?\[\s?\]\s+(.+?)\s*$/;
const CHIP_LINE_RE = /^\s*(?:\[[^\]\n]{1,60}\]\s*){2,4}$/;

/** Parse the tail of a reply for a closing question and quick-reply options (spec §5b). */
export function parseReplyQuestion(text: string): ReplyQuestion {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const options: string[] = [];
  let i = lines.length - 1;
  if (i >= 0 && CHIP_LINE_RE.test(lines[i])) {
    for (const m of lines[i].matchAll(/\[([^\]]+)\]/g)) options.push(m[1].trim());
    i--;
  } else {
    while (i >= 0) {
      const m = OPTION_LINE_RE.exec(lines[i]);
      if (!m) break;
      options.unshift(m[1]);
      i--;
    }
  }
  const tail = i >= 0 ? lines[i].trim() : '';
  const asks = tail.endsWith('?');
  return { asks, options: asks && options.length >= 2 && options.length <= 4 ? options : [] };
}
