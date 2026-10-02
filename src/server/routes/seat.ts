import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { getUser, hasSeatToken } from '../db.js';
import * as outputWatcher from '../output-watcher.js';
import {
  createSeat,
  getSeatStatus,
  rebriefSeat,
  revokeSeatToken,
  rotateSeatToken,
  seatErrorStatus,
  setSeatRules,
} from '../seats.js';

/** Settings → My seat (spec §5d). Every route acts on the caller's own seat only. */
export function registerSeatRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/users/me/seat', (c) => {
    const user = getActingUser(c);
    const fresh = getUser(user.id);
    const me = fresh.ok ? fresh.data : user;
    const status = getSeatStatus(me);
    return c.json({
      ...status,
      eligible: user.role !== 'observer' && fresh.ok,
      rules: me.seat_rules ?? null,
      has_token: fresh.ok ? hasSeatToken(me.id) : false,
    });
  });

  app.post('/api/users/me/seat', async (c) => {
    const body = await c.req.json<{ runtime?: unknown }>().catch(() => ({} as { runtime?: unknown }));
    const result = createSeat(getActingUser(c), { runtime: body?.runtime });
    if (!result.ok) return c.json({ error: result.error }, seatErrorStatus(result.code));
    outputWatcher.startWatching(result.data.agent.id);
    return c.json({
      agent: result.data.agent,
      mcp: result.data.mcp.ok ? { registered: true } : { registered: false, error: result.data.mcp.error, token: result.data.token },
    }, 201);
  });

  app.put('/api/users/me/seat/rules', async (c) => {
    const body = await c.req.json<{ rules?: unknown }>().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'Body must be a JSON object' }, 400);
    const result = setSeatRules(getActingUser(c), body.rules ?? null);
    if (!result.ok) return c.json({ error: result.error }, seatErrorStatus(result.code));
    return c.json({ rules: result.data.seat_rules ?? null });
  });

  app.post('/api/users/me/seat/brief', async (c) => {
    const result = await rebriefSeat(getActingUser(c));
    if (!result.ok) return c.json({ error: result.error }, seatErrorStatus(result.code));
    return c.json({ ok: true });
  });

  app.delete('/api/users/me/seat/token', (c) => {
    const result = revokeSeatToken(getActingUser(c));
    if (!result.ok) return c.json({ error: result.error }, seatErrorStatus(result.code));
    return c.json({ ok: true, has_token: false });
  });

  app.post('/api/users/me/seat/token', (c) => {
    const result = rotateSeatToken(getActingUser(c));
    if (!result.ok) return c.json({ error: result.error }, seatErrorStatus(result.code));
    return c.json({
      ok: true,
      has_token: true,
      // the running seat still holds the old token in its MCP session
      restart_required: true,
      mcp: result.data.ok ? { registered: true } : { registered: false, error: result.data.error },
    });
  });
}
