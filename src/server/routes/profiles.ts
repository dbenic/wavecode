import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { canLoginProfile, loginSeatErrorStatus, loginSessionName, openLoginSeat } from '../login-seats.js';
import * as outputWatcher from '../output-watcher.js';
import { profileStatuses } from '../profiles.js';
import { getConfig } from '../config.js';
import { getAgentByName, listAgents } from '../db.js';
import { subscriptionFor } from '../subscription-info.js';

export function registerProfileRoutes(app: Hono<NodeAppEnv>): void {
  /**
   * Credential profiles (spec §5): per profile and runtime, whether a
   * credential file exists. Contents (and paths) are never returned.
   */
  app.get('/api/profiles', (c) => {
    const user = getActingUser(c);
    const cfg = getConfig();
    const agents = listAgents();
    return c.json(profileStatuses().map((p) => {
      const runtimes: Record<string, { logged_in: boolean; subscription: { account: string | null; plan: string | null } | null; login_seat: { agent_id: string; session: string } | null; agents: number }> = {};
      for (const [rt, st] of Object.entries(p.runtimes)) {
        const seatName = `login-${p.name}-${rt}`;
        const seat = getAgentByName(seatName);
        let subscription: { account: string | null; plan: string | null } | null = null;
        if (st.logged_in) {
          try { subscription = subscriptionFor(rt, p.name); } catch { subscription = null; }
        }
        runtimes[rt] = {
          logged_in: st.logged_in,
          subscription,
          login_seat: seat.ok ? { agent_id: seat.data.id, session: loginSessionName(p.name, rt) } : null,
          agents: agents.filter((a) => a.profile === p.name && a.runtime === rt && !a.tmux_session.startsWith('wc-login-')).length,
        };
      }
      return {
        name: p.name,
        shared: p.shared,
        public: cfg.profiles?.[p.name]?.public === true,
        mine: user.profile === p.name,
        can_login: canLoginProfile(user, p.name),
        runtimes,
      };
    }));
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
