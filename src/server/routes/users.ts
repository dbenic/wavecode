import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { listUsers } from '../db.js';
import { emit } from '../event-bus.js';
import logger from '../logger.js';
import { createUser, isAdmin, OWNER_USER, revokeUser } from '../users.js';
import { getSeatStatus, removeSeatOf } from '../seats.js';
import { releaseLeasesOf } from '../leases.js';

function publicUser(user: { id: string; name: string; role: string; color: string; profile: string | null }) {
  return { id: user.id, name: user.name, role: user.role, color: user.color, profile: user.profile };
}

export function registerUserRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/me', (c) => {
    const user = c.get('user');
    // Spec §5d: the Center needs to know whether to offer "Create / Recreate my seat"
    const seat = getSeatStatus(user);
    return c.json({
      ...publicUser(user),
      seat: seat.status === 'ok' ? { status: 'ok', agent_id: seat.agent.id } : seat,
    });
  });

  app.get('/api/users', (c) => {
    // The synthetic owner is listed first so the UI can render its color/name
    // for events attributed to the fallback token.
    return c.json([OWNER_USER, ...listUsers()].map((u) => ({ ...publicUser(u), created_at: u.created_at })));
  });

  app.post('/api/users', async (c) => {
    const actor = c.get('user');
    if (!isAdmin(actor)) return c.json({ error: 'Forbidden: admin only' }, 403);

    type CreateBody = { name?: unknown; role?: unknown; color?: unknown; profile?: unknown };
    // Malformed JSON is the caller's error (400), never an unhandled 500
    let body: CreateBody;
    try {
      body = await c.req.json<CreateBody>();
    } catch {
      return c.json({ error: 'Malformed JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }
    const result = createUser({ name: body?.name, role: body?.role, color: body?.color, profile: body?.profile });
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

    // Spec §5d: the person's seat goes with them — otherwise releasing its
    // lease would leave an ownerless orchestrator the dispatcher could use.
    const seatRemoved = removeSeatOf(id);

    const result = revokeUser(id);
    if (!result.ok) {
      const status = result.error.includes('not found') ? 404 : 400;
      return c.json({ error: result.error }, status);
    }

    const released = releaseLeasesOf(id);
    logger.info({ userId: id, actorId: actor.id, released }, 'User revoked');
    emit('user.revoked', 'user', id, { released_agents: released, seat_removed: seatRemoved });
    return c.json({ ok: true });
  });
}
