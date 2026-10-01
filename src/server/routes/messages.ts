import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import {
  getAgent,
  getAgentByName,
  insertAgentMessage,
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
      /** Recipient agent id or name (alias of to_agent_id, used by the composer's Reply). */
      to?: string | null;
      workspace?: string | null;
      message: string;
      message_type?: AgentMessage['message_type'];
      ref_task_id?: string | null;
      ref_run_id?: string | null;
    }>();

    if (!body.message?.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }

    let toAgentId = body.to_agent_id ?? null;
    if (body.to && !toAgentId) {
      const byId = getAgent(body.to);
      const resolved = byId.ok ? byId : getAgentByName(body.to);
      if (!resolved.ok) return c.json({ error: `Unknown agent '${body.to}'` }, 400);
      toAgentId = resolved.data.id;
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
    });

    if (!result.ok) return c.json({ error: result.error }, 500);

    emit('message.created', 'agent_message', result.data.id, {
      from_agent_id: result.data.from_agent_id,
      to_agent_id: result.data.to_agent_id,
      workspace: result.data.workspace,
      message_type: result.data.message_type,
    });

    if (!recipient?.ok) return c.json(result.data, 201);
    const injection = injectReply(recipient.data, formatInjectedReply(user.name, result.data.message));
    return c.json({ ...result.data, injected: injection.ok, ...(injection.ok ? {} : { inject_error: injection.error }) }, 201);
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
