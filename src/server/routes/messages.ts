import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import {
  getAgent,
  insertAgentMessage,
  listAgentMessages,
  type AgentMessage,
} from '../db.js';
import { emit } from '../event-bus.js';

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
      workspace?: string | null;
      message: string;
      message_type?: AgentMessage['message_type'];
      ref_task_id?: string | null;
      ref_run_id?: string | null;
    }>();

    if (!body.message?.trim()) {
      return c.json({ error: 'message is required' }, 400);
    }

    const result = insertAgentMessage({
      from_agent_id: body.from_agent_id ?? null,
      to_agent_id: body.to_agent_id ?? null,
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

    return c.json(result.data, 201);
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
