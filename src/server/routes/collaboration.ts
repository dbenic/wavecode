import type { Hono } from 'hono';
import * as commandChat from '../command-chat.js';
import * as teamManager from '../team-manager.js';
import * as validate from '../validate.js';
import type { NodeAppEnv } from '../auth.js';

export function registerCollaborationRoutes(app: Hono<NodeAppEnv>): void {
  app.post('/api/chat/send', async (c) => {
    const body = await c.req.json<{ message: string }>();
    const chatValidation = validate.validateChatBody(body);
    if (chatValidation) return c.json({ error: chatValidation }, 400);

    try {
      const result = await commandChat.chat(body.message);
      return c.json(result);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.get('/api/chat/history', (c) => {
    return c.json(commandChat.getChatHistory());
  });

  app.delete('/api/chat/history', (c) => {
    commandChat.clearChatHistory();
    return c.json({ ok: true });
  });

  app.get('/api/teams', (c) => {
    const teams = teamManager.listTeams();
    return c.json(teams.map((team) => ({
      ...team,
      members: teamManager.getTeamMembers(team.id),
    })));
  });

  app.post('/api/teams', async (c) => {
    const body = await c.req.json<{ name: string; description?: string }>();
    const result = teamManager.createTeam(body.name, body.description);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data, 201);
  });

  app.post('/api/teams/:id/members', async (c) => {
    const body = await c.req.json<{ agent_id: string; role?: string }>();
    const result = teamManager.addMember(c.req.param('id'), body.agent_id, body.role ?? 'member');
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.get('/api/teams/:id/messages', (c) => {
    return c.json(teamManager.getTeamMessages(c.req.param('id')));
  });
}
