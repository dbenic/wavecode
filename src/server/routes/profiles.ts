import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { loginSeatErrorStatus, openLoginSeat } from '../login-seats.js';
import * as outputWatcher from '../output-watcher.js';
import { profileStatuses } from '../profiles.js';

export function registerProfileRoutes(app: Hono<NodeAppEnv>): void {
  /**
   * Credential profiles (spec §5): per profile and runtime, whether a
   * credential file exists. Contents (and paths) are never returned.
   */
  app.get('/api/profiles', (c) => {
    const user = getActingUser(c);
    return c.json(profileStatuses().map((p) => ({ ...p, mine: user.profile === p.name })));
  });

  /** Open a login seat: an adopted agent running the runtime's login command on this profile. */
  app.post('/api/profiles/:name/login', async (c) => {
    const body = await c.req.json<{ runtime?: unknown }>().catch(() => ({} as { runtime?: unknown }));
    if (typeof body.runtime !== 'string' || !body.runtime) return c.json({ error: 'runtime is required' }, 400);

    const result = openLoginSeat({ profile: c.req.param('name'), runtime: body.runtime, user: getActingUser(c) });
    if (!result.ok) return c.json({ error: result.error }, loginSeatErrorStatus(result.code));

    // Watch it so AgentView shows the device-code URL live
    outputWatcher.startWatching(result.data.agent.id);
    return c.json(result.data, 201);
  });
}
