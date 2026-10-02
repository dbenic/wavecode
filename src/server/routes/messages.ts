import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import {
  getAgent,
  getUser,
  getUserByName,
  insertAgentMessage,
  resolveAgent,
  listAgentMessages,
  type Agent,
  type AgentMessage,
} from '../db.js';
import { emit } from '../event-bus.js';
import { isFileRunnerSeat } from '../file-runner.js';
import * as leases from '../leases.js';
import logger from '../logger.js';
import { getRuntimeState } from '../runtime-liveness.js';
import * as sessionManager from '../session-manager.js';
import * as replyCapture from '../reply-capture.js';
import { notify } from '../notifications.js';
import { withPersona } from '../agent-identity.js';
import { recentFeedback, recordFeedback } from '../feedback.js';
import { OWNER_USER } from '../users.js';

/** `@ana` / `ana` / a user id → that user (spec §5c people addressing). */
function resolveUserRef(ref: string) {
  const key = ref.trim().replace(/^@/, '');
  if (key === OWNER_USER.name || key === OWNER_USER.id) return { ok: true as const, data: OWNER_USER };
  const byName = getUserByName(key);
  return byName.ok ? byName : getUser(key);
}

/** Text typed into the recipient's pane for a human reply (spec §4.2). */
export function formatInjectedReply(userName: string, message: string): string {
  return `[from ${userName}] ${message}`;
}

export function registerMessageRoutes(app: Hono<NodeAppEnv>): void {
  // List messages — optionally filtered by workspace, to/from agent
  app.get('/api/messages', (c) => {
    const workspace = c.req.query('workspace');
    const toAgentId = c.req.query('to_agent_id');
    const fromAgentId = c.req.query('from_agent_id');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const messages = listAgentMessages({
      workspace: workspace ?? undefined,
      to_agent_id: toAgentId ?? undefined,
      from_agent_id: fromAgentId ?? undefined,
      limit,
    });

    return c.json(messages);
  });

  // Create a message (from UI or inter-agent)
  app.post('/api/messages', async (c) => {
    const body = await c.req.json<{
      from_agent_id?: string | null;
      to_agent_id?: string | null;
      /** Recipient agent alias, name or id (alias of to_agent_id, used by the composer's Reply). */
      to?: string | null;
      /** Address a person (`@ana`): lands in their Attention filter + notification mirror (spec §5c). */
      to_user?: string | null;
      workspace?: string | null;
      message: string;
      message_type?: AgentMessage['message_type'];
      ref_task_id?: string | null;
      ref_run_id?: string | null;
    }>();

    if (!body.message?.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }
    // Replies are captured from the agent's pane by the server (spec §5b), never posted by clients
    if (body.message_type === 'reply') {
      return c.json({ error: "message_type 'reply' is reserved for captured agent replies" }, 400);
    }

    // Both `to` and `to_agent_id` accept alias / name / id (MCP documents it that way)
    let toAgentId: string | null = null;
    const agentRef = body.to_agent_id || body.to;
    if (agentRef) {
      const resolved = resolveAgent(agentRef);
      if (!resolved.ok) return c.json({ error: `Unknown agent '${agentRef}'` }, 400);
      toAgentId = resolved.data.id;
    }

    let toUser: { id: string; name: string } | null = null;
    if (body.to_user) {
      if (toAgentId) return c.json({ error: 'Address either an agent (to) or a person (to_user), not both' }, 400);
      const resolvedUser = resolveUserRef(body.to_user);
      if (!resolvedUser.ok) return c.json({ error: `Unknown person '${body.to_user}'` }, 400);
      toUser = resolvedUser.data;
    }

    // A human message to an agent (no from_agent_id) is a reply: it is also
    // typed into the agent's tmux, so the §2 rule-2 ownership guard applies.
    const user = getActingUser(c);
    const recipient = toAgentId && !body.from_agent_id ? getAgent(toAgentId) : null;
    if (recipient?.ok) {
      const access = leases.checkAgentAccess(recipient.data, user);
      if (!access.ok) return c.json({ error: access.error }, 403);
    }

    const result = insertAgentMessage({
      from_agent_id: body.from_agent_id ?? null,
      to_agent_id: toAgentId,
      workspace: body.workspace ?? null,
      message: body.message.trim(),
      message_type: body.message_type,
      ref_task_id: body.ref_task_id ?? null,
      ref_run_id: body.ref_run_id ?? null,
      to_user_id: toUser?.id ?? null,
    });

    if (!result.ok) return c.json({ error: result.error }, 500);

    const created = emit('message.created', 'agent_message', result.data.id, {
      from_agent_id: result.data.from_agent_id,
      to_agent_id: result.data.to_agent_id,
      workspace: result.data.workspace,
      message_type: result.data.message_type,
      ...(toUser ? { to_user_id: toUser.id, to_user: toUser.name } : {}),
    });

    if (toUser) {
      // Mirror to the person's phone (push / ntfy / Telegram); never fail the message on it
      // Notification channels are per-install, not per-user, so the body
      // must stay in the UI — only the fact of a message is mirrored.
      void notify({
        title: `New WaveCode message for @${toUser.name}`,
        body: `From ${user.name} — open the Command Center to read it`,
        url: '/',
        tag: `message-${result.data.id}`,
      }).catch((err) => logger.warn({ error: (err as Error).message }, 'Message notification failed'));
    }

    if (!recipient?.ok) return c.json(result.data, 201);
    // Spec §5c: the agent's persona is prepended to everything typed into it
    const injectedText = withPersona(recipient.data, formatInjectedReply(user.name, result.data.message));
    const injection = injectReply(recipient.data, injectedText);
    if (injection.ok) {
      // Spec §5b: the agent's answer appears in the thread under this message
      replyCapture.trackPrompt({ agent: recipient.data, actorId: user.id, prompt: injectedText, promptEventId: created?.id ?? null });
    }
    return c.json({ ...result.data, injected: injection.ok, ...(injection.ok ? {} : { inject_error: injection.error }) }, 201);
  });

  // --- Feedback on replies (spec §5f) ---
  app.post('/api/messages/:id/feedback', async (c) => {
    const body = await c.req.json<{ score?: unknown; note?: unknown }>().catch(() => ({} as { score?: unknown; note?: unknown }));
    const result = recordFeedback(getActingUser(c), c.req.param('id'), body ?? {});
    if (!result.ok) return c.json({ error: result.error }, result.code === 'not_found' ? 404 : result.code === 'forbidden' ? 403 : 400);
    return c.json(result.data);
  });

  /**
   * Recent feedback on replies. `agent` (alias/name/id) narrows it; without
   * it, a caller with a seat gets their seat's feedback (what `list_feedback`
   * shows a seat at the start of a session).
   */
  app.get('/api/feedback', (c) => {
    const ref = c.req.query('agent');
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 200);
    let agentId: string | null = null;
    if (ref) {
      const agent = resolveAgent(ref);
      if (!agent.ok) return c.json({ error: agent.error }, 404);
      agentId = agent.data.id;
    } else {
      const me = getUser(getActingUser(c).id);
      agentId = me.ok ? me.data.seat_agent_id ?? null : null;
    }
    return c.json(recentFeedback(agentId, limit));
  });

  // Messages for a specific agent (sent to them or broadcast)
  app.get('/api/agents/:id/messages', (c) => {
    const agentId = c.req.param('id');
    const agentResult = getAgent(agentId);
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : 100;
    const workspace = agentResult.data.workspace;

    const messages = listAgentMessages({
      to_agent_id: agentId,
    }).filter((message) => (
      message.to_agent_id === agentId
      || (message.to_agent_id === null && message.workspace === workspace)
    )).slice(0, limit);

    return c.json(messages);
  });
}

/**
 * Type a reply into the agent's pane. The message is already persisted, so a
 * failure is reported to the caller rather than failing the request. Never
 * types into a bare shell (T0) or a file-runner seat (no pane).
 */
function injectReply(agent: Agent, text: string): { ok: true } | { ok: false; error: string } {
  if (isFileRunnerSeat(agent)) return { ok: false, error: 'File-runner seats have no terminal' };
  if (getRuntimeState(agent) === 'dead') return { ok: false, error: 'runtime not running' };
  const sent = sessionManager.sendKeys(agent.id, text);
  if (!sent.ok) {
    logger.warn({ agentId: agent.id, error: sent.error }, 'Reply injection failed');
    return { ok: false, error: sent.error };
  }
  // No agent.prompt_sent here: message.created already puts the reply in the thread.
  return { ok: true };
}
