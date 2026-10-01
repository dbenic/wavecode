/**
 * The Command Center feed (multi-orchestrator spec §4.1): one ordered,
 * typed stream built from the event log, so the UI never stitches five
 * endpoints together.
 *
 * Every item maps deterministically from one event (no LLM). `actions` are
 * the exact REST calls the viewer may make for that item, computed here
 * from the ownership rules of §2 — the UI carries zero permission logic.
 * Body templates use `{placeholders}` the UI fills (`{text}`, `{agent_id}`,
 * `{reason}`, `{artifact_id}`).
 */

import {
  getAgent,
  getAgentMessage,
  getRun,
  getLatestEventId,
  listEvents,
  listEventsBefore,
  type Agent,
  type AgentMessage,
  type Run,
  type User,
  type WaveEvent,
} from './db.js';
import { checkAgentAccess } from './leases.js';
import { canMutate, isAdmin } from './users.js';

export const THREAD_KINDS = ['prompt', 'report', 'request', 'run', 'verdict', 'task', 'alert', 'artifact'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export function isThreadKind(value: string): value is ThreadKind {
  return (THREAD_KINDS as readonly string[]).includes(value);
}

export interface ThreadAction {
  id: string;
  label: string;
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: Record<string, unknown>;
}

export interface ThreadItem {
  id: string;
  event_id: number;
  at: string;
  kind: ThreadKind;
  type: string;            // underlying event type, e.g. 'run.failed'
  agent_id: string | null;
  actor_id: string | null;
  title: string;
  body: string | null;
  refs: { task_id?: string; run_id?: string; review_id?: string; artifact_id?: string; message_id?: string };
  needs_attention: boolean;
  actions: ThreadAction[];
}

/** Per-request lookup cache so a page of events costs one query per entity. */
export class ThreadContext {
  private agents = new Map<string, Agent | null>();
  private runs = new Map<string, Run | null>();
  private messages = new Map<string, AgentMessage | null>();

  constructor(readonly viewer: Pick<User, 'id' | 'name' | 'role'>) {}

  agent(id: string | null | undefined): Agent | null {
    if (!id) return null;
    if (!this.agents.has(id)) {
      const r = getAgent(id);
      this.agents.set(id, r.ok ? r.data : null);
    }
    return this.agents.get(id) ?? null;
  }

  run(id: string): Run | null {
    if (!this.runs.has(id)) {
      const r = getRun(id);
      this.runs.set(id, r.ok ? r.data : null);
    }
    return this.runs.get(id) ?? null;
  }

  message(id: string): AgentMessage | null {
    if (!this.messages.has(id)) {
      const r = getAgentMessage(id);
      this.messages.set(id, r.ok ? r.data : null);
    }
    return this.messages.get(id) ?? null;
  }

  /** Not an observer. */
  get canMutate(): boolean {
    return canMutate(this.viewer);
  }

  /** Rule 2 + not an observer: may prompt / assign / kill this agent. */
  canAct(agentId: string | null | undefined): boolean {
    if (!this.canMutate) return false;
    const agent = this.agent(agentId);
    return !!agent && checkAgentAccess(agent, this.viewer).ok;
  }
}

type Payload = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function clip(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function replyAction(agentId: string, taskId: string | null): ThreadAction {
  return {
    id: 'reply',
    label: 'Reply',
    method: 'POST',
    path: '/api/messages',
    body: { to: agentId, message: '{text}', message_type: 'info', ...(taskId ? { ref_task_id: taskId } : {}) },
  };
}

function base(event: WaveEvent, kind: ThreadKind, agentId: string | null, title: string): ThreadItem {
  return {
    id: `ev-${event.id}`,
    event_id: event.id,
    at: event.created_at,
    kind,
    type: event.type,
    agent_id: agentId,
    actor_id: event.actor_id ?? null,
    title,
    body: null,
    refs: {},
    needs_attention: false,
    actions: [],
  };
}

const QUESTION_RE = /\?\s*$/;
const TASK_TYPES = new Set(['task.created', 'task.dispatched', 'task.completed', 'task.blocked', 'task.waiting_for_agent', 'task.failed']);
const ALERT_TYPES = new Set(['agent.crashed', 'agent.hung', 'agent.lease_expired', 'agent.runtime_relaunched', 'system.stop_all']);

/** Map one event to a thread item, or null when the event is not part of the feed. */
export function toThreadItem(event: WaveEvent, ctx: ThreadContext): ThreadItem | null {
  const p: Payload = event.payload_json ? JSON.parse(event.payload_json) : {};
  const t = event.type;

  // --- prompt: what a person typed into an agent
  if (t === 'agent.prompt_sent') {
    const item = base(event, 'prompt', event.entity_id, 'Prompt sent');
    item.body = str(p.text);
    return item;
  }

  // --- report / request: the agent wire
  if (t === 'message.created') {
    const msg = ctx.message(event.entity_id);
    const type = (msg?.message_type ?? str(p.message_type) ?? 'info') as AgentMessage['message_type'];
    if (type === 'error') {
      const agentId = msg?.from_agent_id ?? str(p.from_agent_id);
      const item = base(event, 'alert', agentId, 'Agent reported an error');
      item.body = msg?.message ?? null;
      item.refs = { message_id: event.entity_id, ...(msg?.ref_task_id ? { task_id: msg.ref_task_id } : {}) };
      item.needs_attention = true;
      if (agentId && ctx.canAct(agentId)) item.actions.push(replyAction(agentId, msg?.ref_task_id ?? null));
      return item;
    }
    const isRequest = type === 'request';
    // A message from an agent is about that agent; a human message is about its recipient.
    const agentId = msg?.from_agent_id ?? str(p.from_agent_id) ?? msg?.to_agent_id ?? str(p.to_agent_id);
    const fromAgent = msg?.from_agent_id ?? str(p.from_agent_id);
    const title = isRequest ? 'Question' : fromAgent ? `Report (${type})` : 'Reply';
    const item = base(event, isRequest ? 'request' : 'report', agentId, title);
    item.body = msg?.message ?? null;
    item.refs = {
      message_id: event.entity_id,
      ...(msg?.ref_task_id ? { task_id: msg.ref_task_id } : {}),
      ...(msg?.ref_run_id ? { run_id: msg.ref_run_id } : {}),
    };
    item.needs_attention = isRequest;
    if (agentId && ctx.canAct(agentId)) {
      item.actions.push(replyAction(agentId, msg?.ref_task_id ?? null));
      if (isRequest) {
        item.actions.push({
          id: 'send_file',
          label: 'Send file',
          method: 'POST',
          path: '/api/artifacts/{artifact_id}/share',
          body: { target_agent_id: agentId },
        });
      }
    }
    return item;
  }

  // --- request from the pane: idle with a trailing question
  if (t === 'agent.status_changed') {
    const line = str(p.lastOutputLine);
    if (p.status !== 'idle' || !line || !QUESTION_RE.test(line)) return null;
    const item = base(event, 'request', event.entity_id, 'Agent is asking');
    item.body = line;
    item.needs_attention = true;
    if (ctx.canAct(event.entity_id)) item.actions.push(replyAction(event.entity_id, null));
    return item;
  }

  // --- run lifecycle
  if (t === 'run.started' || t === 'run.finished' || t === 'run.failed' || t === 'run.phase') {
    const run = ctx.run(event.entity_id);
    const agentId = str(p.agent_id) ?? run?.agent_id ?? null;
    const phase = str(p.phase);
    if (t === 'run.phase' && phase !== 'failed' && phase !== 'incomplete') return null; // progress noise
    const failed = t === 'run.failed' || phase === 'failed' || phase === 'incomplete';
    const result = str(p.result);
    const title = t === 'run.started'
      ? 'Run started'
      : failed
        ? `Run ${phase === 'incomplete' ? 'incomplete' : 'failed'}${result ? ` · RESULT: ${result}` : ''}`
        : `Run finished · exit ${p.exit_code ?? 0}${result ? ` · RESULT: ${result}` : ''}`;
    const item = base(event, 'run', agentId, title);
    item.body = str(p.result_reason) ?? str(p.reason) ?? str(p.error) ?? str(p.prompt);
    const taskId = str(p.task_id) ?? run?.task_id ?? null;
    item.refs = { run_id: event.entity_id, ...(taskId ? { task_id: taskId } : {}) };
    item.needs_attention = failed;
    item.actions.push({ id: 'open_log', label: 'Open log', method: 'GET', path: `/api/runs/${event.entity_id}/log` });
    if (t !== 'run.started' && ctx.canMutate) {
      if (ctx.canAct(agentId)) {
        item.actions.push({ id: 'retry', label: 'Retry', method: 'POST', path: `/api/reviews/${event.entity_id}/retry` });
      }
      item.actions.push({
        id: 'hand_off',
        label: 'Hand off',
        method: 'POST',
        path: `/api/reviews/${event.entity_id}/handoff`,
        body: { targetAgentId: '{agent_id}' },
      });
    }
    return item;
  }

  // --- AI review verdict
  if (t === 'review.ai_completed') {
    const run = ctx.run(event.entity_id);
    const verdict = str(p.verdict) ?? 'needs-fixes';
    const issues = typeof p.issues_found === 'number' ? p.issues_found : null;
    const item = base(
      event,
      'verdict',
      run?.agent_id ?? null,
      `${verdict.toUpperCase().replace('-', ' ')}${issues ? ` (${issues} issue${issues === 1 ? '' : 's'})` : ''}`,
    );
    const reviewId = str(p.review_id);
    item.refs = {
      run_id: event.entity_id,
      ...(reviewId ? { review_id: reviewId } : {}),
      ...(run?.task_id ? { task_id: run.task_id } : {}),
    };
    item.body = typeof p.fix_round === 'number' ? `Fix round ${p.fix_round}` : null;
    item.needs_attention = verdict !== 'pass';
    if (ctx.canMutate) {
      const promote = `/api/reviews/${event.entity_id}/promote`;
      if (verdict === 'pass') {
        item.actions.push({ id: 'promote', label: 'Promote', method: 'POST', path: promote });
      } else if (isAdmin(ctx.viewer)) {
        item.actions.push({ id: 'override_promote', label: 'Override promote', method: 'POST', path: promote, body: { overrideReason: '{reason}' } });
      }
      if (verdict !== 'pass' && reviewId && ctx.canAct(run?.agent_id)) {
        item.actions.push({ id: 'send_fixes', label: 'Send fixes', method: 'POST', path: `/api/ai-reviews/${reviewId}/send-fixes` });
      }
      item.actions.push({ id: 'reject', label: 'Reject', method: 'POST', path: `/api/reviews/${event.entity_id}/reject` });
    }
    return item;
  }

  // --- task board
  if (TASK_TYPES.has(t)) {
    const agentId = str(p.agent_id);
    const verb = t.slice('task.'.length).replace(/_/g, ' ');
    const waiting = t === 'task.waiting_for_agent';
    const item = base(
      event,
      'task',
      agentId,
      !waiting
        ? `Task ${verb}`
        : p.reason === 'profile'
          ? `Task waiting for ${str(p.agent_name) ?? 'agent'} (runs on profile ${str(p.profile) ?? '?'})`
          : `Task waiting for ${str(p.agent_name) ?? 'agent'} (owned by ${str(p.owner) ?? 'someone'})`,
    );
    item.body = str(p.prompt) ?? str(p.error) ?? str(p.reason);
    item.refs = { task_id: event.entity_id, ...(str(p.run_id) ? { run_id: str(p.run_id)! } : {}) };
    item.needs_attention = t === 'task.blocked' || waiting;
    if (ctx.canMutate && (item.needs_attention || t === 'task.failed')) {
      item.actions.push({
        id: 'reassign',
        label: 'Reassign',
        method: 'PUT',
        path: `/api/tasks/${event.entity_id}`,
        body: { agent_id: '{agent_id}' },
      });
    }
    if (waiting && agentId && ctx.canAct(agentId)) {
      // Only the owner (or an admin) gets this — it is their lease that blocks the task.
      item.actions.push({ id: 'release_agent', label: 'Release agent', method: 'POST', path: `/api/agents/${agentId}/release` });
    }
    return item;
  }

  // --- alerts
  if (ALERT_TYPES.has(t)) {
    const agentId = event.entity_type === 'agent' ? event.entity_id : null;
    const titles: Record<string, string> = {
      'agent.crashed': 'Agent crashed',
      'agent.hung': `Agent appears hung${typeof p.stale_minutes === 'number' ? ` (${p.stale_minutes}m silent)` : ''}`,
      'agent.lease_expired': `Lease expired (${str(p.owner) ?? 'owner'})`,
      'agent.runtime_relaunched': 'Runtime had exited — relaunched',
      'system.stop_all': 'Emergency stop-all',
    };
    const item = base(event, 'alert', agentId, titles[t]);
    item.needs_attention = true;
    if (agentId && ctx.canAct(agentId)) {
      if (t !== 'agent.lease_expired') {
        item.actions.push({ id: 'restart', label: 'Restart', method: 'POST', path: `/api/agents/${agentId}/restart` });
      }
      item.actions.push({ id: 'kill', label: 'Kill', method: 'POST', path: `/api/agents/${agentId}/kill` });
    }
    return item;
  }

  // --- artifacts
  if (t === 'artifact.created' || t === 'artifact.shared') {
    const agentId = str(p.target_agent_id) ?? str(p.source_agent_id);
    const item = base(event, 'artifact', agentId, `${t === 'artifact.shared' ? 'File shared' : 'File added'}: ${str(p.filename) ?? event.entity_id}`);
    item.body = str(p.attached_path);
    item.refs = { artifact_id: event.entity_id, ...(str(p.source_run_id) ? { run_id: str(p.source_run_id)! } : {}) };
    item.actions.push({ id: 'open', label: 'Open', method: 'GET', path: `/api/artifacts/${event.entity_id}/download` });
    if (ctx.canMutate) {
      item.actions.push({
        id: 'forward',
        label: 'Forward',
        method: 'POST',
        path: `/api/artifacts/${event.entity_id}/share`,
        body: { target_agent_id: '{agent_id}' },
      });
    }
    return item;
  }

  return null;
}

export interface ThreadQuery {
  /** Agent id, or null/'all' for every agent. */
  agentId?: string | null;
  /** Only items whose agent this user currently owns, or that this user caused. */
  ownerId?: string | null;
  kinds?: ThreadKind[] | null;
  attentionOnly?: boolean;
  /** Exclusive event-id cursor. Omitted → the newest `limit` items. */
  since?: number | null;
  limit?: number;
}

const SCAN_BATCH = 200;
/** Upper bound on events scanned per call so a narrow filter cannot walk the whole log. */
const MAX_SCAN = 5000;

function matches(item: ThreadItem, q: ThreadQuery, ctx: ThreadContext): boolean {
  if (q.kinds && q.kinds.length > 0 && !q.kinds.includes(item.kind)) return false;
  if (q.attentionOnly && !item.needs_attention) return false;
  if (q.agentId && q.agentId !== 'all' && item.agent_id !== q.agentId) return false;
  if (q.ownerId) {
    const owned = ctx.agent(item.agent_id)?.owner_id === q.ownerId;
    if (!owned && item.actor_id !== q.ownerId) return false;
  }
  return true;
}

/**
 * One page of the feed, oldest → newest. `cursor` is the last event id
 * scanned (pass it back as `since`); it advances past filtered-out events
 * so a poller never re-reads them.
 */
export function readThread(q: ThreadQuery, viewer: Pick<User, 'id' | 'name' | 'role'>): { items: ThreadItem[]; cursor: number } {
  const ctx = new ThreadContext(viewer);
  const limit = Math.max(1, Math.min(q.limit ?? 100, 500));
  const items: ThreadItem[] = [];
  let scanned = 0;

  if (q.since === undefined || q.since === null) {
    // Initial load: walk backwards from the newest event.
    const cursor = getLatestEventId();
    let before: number | null = null;
    while (items.length < limit && scanned < MAX_SCAN) {
      const page = listEventsBefore(before, SCAN_BATCH);
      if (page.length === 0) break;
      scanned += page.length;
      for (const ev of page) {
        const item = toThreadItem(ev, ctx);
        if (item && matches(item, q, ctx)) items.push(item);
        if (items.length >= limit) break;
      }
      before = page[page.length - 1].id;
    }
    return { items: items.reverse(), cursor };
  }

  let cursor = q.since;
  while (items.length < limit && scanned < MAX_SCAN) {
    const page = listEvents({ since_id: cursor || undefined, limit: SCAN_BATCH });
    if (page.length === 0) break;
    scanned += page.length;
    for (const ev of page) {
      cursor = ev.id;
      const item = toThreadItem(ev, ctx);
      if (item && matches(item, q, ctx)) items.push(item);
      if (items.length >= limit) break;
    }
    if (page.length < SCAN_BATCH) break;
  }
  return { items, cursor };
}
