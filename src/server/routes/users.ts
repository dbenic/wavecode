import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { listUsers } from '../db.js';
import { emit } from '../event-bus.js';
import logger from '../logger.js';
import { createUser, isAdmin, OWNER_USER, revokeUser } from '../users.js';
import { releaseLeasesOf } from '../leases.js';

function publicUser(user: { id: string; name: string; role: string; color: string }) {
  return { id: user.id, name: user.name, role: user.role, color: user.color };
}

export function registerUserRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/me', (c) => {
    return c.json(publicUser(c.get('user')));
  });

  app.get('/api/users', (c) => {
    // The synthetic owner is listed first so the UI can render its color/name
    // for events attributed to the fallback token.
    return c.json([OWNER_USER, ...listUsers()].map((u) => ({ ...publicUser(u), created_at: u.created_at })));
  });

  app.post('/api/users', async (c) => {
    const actor = c.get('user');
    if (!isAdmin(actor)) return c.json({ error: 'Forbidden: admin only' }, 403);

    const body = await c.req.json<{ name?: unknown; role?: unknown; color?: unknown }>();
    const result = createUser({ name: body?.name, role: body?.role, color: body?.color });
    if (!result.ok) {
      const status = result.error.includes('already exists') ? 409 : 400;
      return c.json({ error: result.error }, status);
    }

    const { user, token } = result.data;
    logger.info({ userId: user.id, role: user.role, actorId: actor.id }, 'User created');
    emit('user.created', 'user', user.id, { name: user.name, role: user.role });
    // The plaintext token is returned exactly once; only its hash is stored.
    return c.json({ ...publicUser(user), created_at: user.created_at, token }, 201);
  });

  app.delete('/api/users/:id', (c) => {
    const actor = c.get('user');
    if (!isAdmin(actor)) return c.json({ error: 'Forbidden: admin only' }, 403);

    const id = c.req.param('id');
    if (id === actor.id) return c.json({ error: 'You cannot revoke your own user' }, 400);

    const result = revokeUser(id);
    if (!result.ok) {
      const status = result.error.includes('not found') ? 404 : 400;
      return c.json({ error: result.error }, status);
    }

    const released = releaseLeasesOf(id);
    logger.info({ userId: id, actorId: actor.id, released }, 'User revoked');
    emit('user.revoked', 'user', id, { released_agents: released });
    return c.json({ ok: true });
  });
}
