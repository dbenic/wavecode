import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { WaveConfig } from '../config.js';
import { collectOnce, resetFableQueueForTest } from '../fable-queue.js';
import { resolveFableQueue } from '../fable-queue-config.js';

const FALLBACK = 'fallback-secret';

function makeConfig(): WaveConfig {
  return { auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] } } as unknown as WaveConfig;
}

async function makeApp() {
  const { createAuthMiddleware } = await import('../auth.js');
  const { registerQueueRoutes } = await import('./queue.js');
  const app = new Hono<import('../auth.js').NodeAppEnv>();
  app.use('/api/*', createAuthMiddleware(() => makeConfig()));
  registerQueueRoutes(app);
  return app;
}

async function call(app: Hono<import('../auth.js').NodeAppEnv>, token: string | null) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.request('/api/queue', { headers });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe('GET /api/queue', () => {
  afterEach(() => resetFableQueueForTest());

  it('requires a token, like the other read routes', async () => {
    const app = await makeApp();
    expect((await call(app, null)).status).toBe(401);
    expect((await call(app, 'bogus')).status).toBe(401);
  });

  it('returns the snapshot and not file bodies', async () => {
    const app = await makeApp();
    const before = await call(app, FALLBACK);
    expect(before.status).toBe(200);
    const bots = before.json.bots as Array<{ id: string }>;
    expect(bots.map((b) => b.id)).toEqual(['fable', 'fable2', 'fable3', 'fable4', 'fable5']);
    expect(before.json.collected_at).toBeNull();

    const secret = 'BODY_SHOULD_NOT_APPEAR';
    await collectOnce({
      now: () => Date.parse('2026-10-23T12:00:00Z'),
      capture: async () => ({ ok: true, data: `password=${secret}\n❯` }),
      listDir: async (dir) => (dir === '/inbox'
        ? { files: [{ name: '145-brief.md', mtimeMs: Date.parse('2026-10-23T11:00:00Z') }], error: null }
        : { files: [], error: null }),
      config: resolveFableQueue({
        fable_queue: {
          bots: [{ id: 'fable', socket: 'fable', session: 'claude-countix', inbox: '/inbox', outbox: '/outbox' }],
          cards: ['#145'],
        },
      }),
    });
    const after = await call(app, FALLBACK);
    expect(after.status).toBe(200);
    const body = JSON.stringify(after.json);
    expect(body).not.toContain(secret);
    expect(body).toContain('[redacted]');
    expect(body).not.toContain(FALLBACK);
    expect(body).toContain('145-brief.md');
    const bot = (after.json.bots as Array<{ state: string; current: { name: string } | null }>)[0];
    expect(bot.state).toBe('idle');
    expect(bot.current?.name).toBe('145-brief.md');
  });
});
