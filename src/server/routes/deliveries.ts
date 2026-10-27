import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { canMutate } from '../users.js';
import {
  addLanes, createDelivery, deriveDelivery, getDelivery, listDeliveries, listStages, setDeliveryStatus, summarize,
  type DeliveryStatus,
} from '../deliveries.js';

/**
 * Deliveries: a feature from spec to production as one record
 * (docs/ops/delivery-tracker-plan.md). Read by people and by the driver seat;
 * written by developers and admins. Nothing here moves code.
 */
export function registerDeliveryRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/deliveries', (c) => {
    const status = (c.req.query('status') ?? 'open') as DeliveryStatus | 'all';
    const limitRaw = Number(c.req.query('limit') ?? 100);
    const deskRaw = c.req.query('desk');
    const desk = deskRaw !== undefined && /^\d+$/.test(deskRaw) ? Number(deskRaw) : null;
    const rows = listDeliveries({ status, limit: Number.isFinite(limitRaw) ? limitRaw : 100, desk });
    return c.json(rows.map((d) => summarize(d, listStages(d.id))));
  });

  app.get('/api/deliveries/:id', (c) => {
    const d = getDelivery(c.req.param('id'));
    if (!d) return c.json({ error: 'delivery not found' }, 404);
    const spans = listStages(d.id);
    return c.json({ ...summarize(d, spans), stages: spans });
  });

  app.post('/api/deliveries', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden: observers cannot create deliveries' }, 403);
    const body = await c.req.json<{
      title?: string; desk?: number | string | null; project?: string | null; lanes?: string[]; goal_id?: string | null; spec_path?: string | null;
      release_lane?: boolean; since?: string | null;
    }>().catch(() => ({} as Record<string, never>));
    const desk = body.desk === undefined || body.desk === null || body.desk === '' ? null : Number(String(body.desk).replace(/^(PD|desk)[-#\s]*/i, ''));
    if (desk !== null && (!Number.isInteger(desk) || desk <= 0)) return c.json({ error: 'desk must be a product-desk number (134 or PD-134)' }, 400);
    if (typeof body.title !== 'string' && desk === null) return c.json({ error: 'title or desk is required' }, 400);
    if (body.lanes !== undefined && (!Array.isArray(body.lanes) || body.lanes.some((l) => typeof l !== 'string'))) {
      return c.json({ error: 'lanes must be a list of branch names' }, 400);
    }
    const created = createDelivery({
      title: typeof body.title === 'string' ? body.title : undefined, desk, project: body.project ?? null, lanes: body.lanes ?? [], goal_id: body.goal_id ?? null,
      spec_path: body.spec_path ?? null, release_lane: body.release_lane === true, since: body.since ?? null, created_by: user.name,
    });
    if (!created.ok) return c.json({ error: created.error }, 400);
    const derived = deriveDelivery(created.data.id);
    if (!derived.ok) return c.json({ error: derived.error }, 500);
    return c.json({ ...summarize(derived.data.delivery, derived.data.spans), stages: derived.data.spans }, 201);
  });

  app.post('/api/deliveries/:id/lanes', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ lanes?: string[] }>().catch(() => ({} as { lanes?: string[] }));
    if (!Array.isArray(body.lanes) || body.lanes.some((l) => typeof l !== 'string')) return c.json({ error: 'lanes must be a list of branch names' }, 400);
    const added = addLanes(c.req.param('id'), body.lanes);
    if (!added.ok) return c.json({ error: added.error }, 404);
    const derived = deriveDelivery(added.data.id);
    if (!derived.ok) return c.json({ error: derived.error }, 500);
    return c.json({ ...summarize(derived.data.delivery, derived.data.spans), stages: derived.data.spans });
  });

  app.post('/api/deliveries/:id/status', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ status?: string }>().catch(() => ({} as { status?: string }));
    if (!body.status || !['open', 'done', 'failed', 'cancelled'].includes(body.status)) return c.json({ error: "status must be open, done, failed or cancelled" }, 400);
    const r = setDeliveryStatus(c.req.param('id'), body.status as DeliveryStatus, user.name);
    if (!r.ok) return c.json({ error: r.error }, 404);
    return c.json(r.data);
  });

  app.post('/api/deliveries/:id/derive', (c) => {
    const derived = deriveDelivery(c.req.param('id'));
    if (!derived.ok) return c.json({ error: derived.error }, 404);
    return c.json({ ...summarize(derived.data.delivery, derived.data.spans), stages: derived.data.spans });
  });
}
