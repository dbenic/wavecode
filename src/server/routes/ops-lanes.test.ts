import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { WaveConfig } from '../config.js';
import { resolveOpsLanes } from '../ops-lanes-config.js';
import { collectOnce, resetOpsLanesForTest } from '../ops-lanes.js';

const FALLBACK = 'fallback-secret';

function makeConfig(): WaveConfig {
  return { auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] } } as unknown as WaveConfig;
}

async function makeApp() {
  const { createAuthMiddleware } = await import('../auth.js');
  const { registerOpsLaneRoutes } = await import('./ops-lanes.js');
  const app = new Hono<import('../auth.js').NodeAppEnv>();
  app.use('/api/*', createAuthMiddleware(() => makeConfig()));
  registerOpsLaneRoutes(app);
  return app;
}

async function call(app: Hono<import('../auth.js').NodeAppEnv>, token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.request('/api/ops-lanes', { headers });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe('GET /api/ops-lanes', () => {
  afterEach(() => resetOpsLanesForTest());

  it('requires a token, like the other read routes', async () => {
    const app = await makeApp();
    expect((await call(app, null)).status).toBe(401);
    expect((await call(app, 'bogus')).status).toBe(401);
  });

  it('returns the snapshot and not heartbeat secrets', async () => {
    const app = await makeApp();
    const before = await call(app, FALLBACK);
    expect(before.status).toBe(200);
    const lanes = before.json.lanes as Array<{ id: string }>;
    expect(lanes.map((lane) => lane.id)).toEqual(['pilot', 'stager', 'scout', 'scribe-hipsl', 'scribe-clients']);
    expect(before.json.collected_at).toBeNull();

    const secret = 'BODY_SHOULD_NOT_APPEAR';
    await collectOnce({
      now: () => Date.parse('2026-10-24T20:00:00.000Z'),
      readHeartbeat: async (_dir, bot) => (bot === 'pilot'
        ? { raw: JSON.stringify({ bot: 'pilot', key_status: 'ok', current_job: `password=${secret}`, heartbeat_at: '2026-10-24T19:59:00.000Z' }) }
        : { error: 'missing' as const }),
      config: resolveOpsLanes({ ops_lanes: { dir: '/lanes', bots: ['pilot', 'stager'] } }),
    });
    const after = await call(app, FALLBACK);
    expect(after.status).toBe(200);
    const body = JSON.stringify(after.json);
    expect(body).not.toContain(secret);
    expect(body).toContain('[redacted]');
    expect(body).not.toContain(FALLBACK);
    expect(body).not.toContain('/lanes');
    const pilot = (after.json.lanes as Array<{ id: string; file: string; red: boolean }>)[0];
    expect(pilot.id).toBe('pilot');
    expect(pilot.file).toBe('ok');
    expect(pilot.red).toBe(false);
  });
});
