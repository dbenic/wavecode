import type { Hono } from 'hono';
import { insertPushSubscription, deletePushSubscription } from '../db.js';
import * as notifications from '../notifications.js';
import type { NodeAppEnv } from '../auth.js';

export function registerPushRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/push/vapid-key', (c) => {
    const key = notifications.getVapidPublicKey();
    if (!key) return c.json({ error: 'Web Push not enabled' }, 404);
    return c.json({ publicKey: key });
  });

  app.post('/api/push/subscribe', async (c) => {
    const body = await c.req.json<{
      endpoint: string;
      keys: { p256dh: string; auth: string };
    }>();

    const result = insertPushSubscription({
      endpoint: body.endpoint,
      keys: body.keys,
      userAgent: c.req.header('User-Agent'),
    });

    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true }, 201);
  });

  app.post('/api/push/unsubscribe', async (c) => {
    const body = await c.req.json<{ endpoint: string }>();
    deletePushSubscription(body.endpoint);
    return c.json({ ok: true });
  });
}
