import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import {
  insertDecision,
  listDecisions,
  listAllDecisions,
  deleteDecision,
  getAgent,
} from '../db.js';
import { emit } from '../event-bus.js';
import { previewBriefing } from '../briefing-builder.js';

export function registerDecisionRoutes(app: Hono<NodeAppEnv>): void {
  // List decisions — optionally filtered by workspace
  app.get('/api/decisions', (c) => {
    const workspace = c.req.query('workspace');
    const decisions = workspace ? listDecisions(workspace) : listAllDecisions();
    return c.json(decisions);
  });

  // Create a decision manually
  app.post('/api/decisions', async (c) => {
    const body = await c.req.json<{
      workspace?: string;
      agent_id?: string;
      summary: string;
      detail?: string;
    }>();

    if (!body.summary?.trim()) {
      return c.json({ error: 'summary is required' }, 400);
    }

    // Resolve workspace from agent if not provided directly
    let workspace = body.workspace;
    if (!workspace && body.agent_id) {
      const agentResult = getAgent(body.agent_id);
      if (agentResult.ok && agentResult.data.workspace) {
        workspace = agentResult.data.workspace;
      }
    }

    if (!workspace) {
      return c.json({ error: 'workspace is required (provide workspace or agent_id with a workspace)' }, 400);
    }

    const result = insertDecision({
      workspace,
      summary: body.summary.trim(),
      detail: body.detail?.trim() ?? null,
      source_agent_id: body.agent_id ?? null,
    });

    if (!result.ok) return c.json({ error: result.error }, 500);

    emit('decision.created', 'decision', result.data.id, {
      workspace,
      summary: result.data.summary,
    });

    return c.json(result.data, 201);
  });

  // Delete a decision
  app.delete('/api/decisions/:id', (c) => {
    const id = c.req.param('id');
    const deleted = deleteDecision(id);
    if (!deleted) return c.json({ error: 'Decision not found' }, 404);
    emit('decision.deleted', 'decision', id, {});
    return c.json({ ok: true });
  });

  // Preview what briefing would be generated for an agent
  app.get('/api/briefing/preview', (c) => {
    const agentId = c.req.query('agent_id');
    if (!agentId) return c.json({ error: 'agent_id required' }, 400);

    const prompt = c.req.query('prompt') ?? '(task prompt)';
    const briefing = previewBriefing(agentId, prompt);

    return c.json({ briefing });
  });
}
