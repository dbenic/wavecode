import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveConfig } from '../config.js';

const FALLBACK = 'fallback-secret';
const SHA = 'c'.repeat(40);

async function call(app: Hono<import('../auth.js').NodeAppEnv>, token: string, body: unknown) {
  const res = await app.request(`/api/merge-queue/${SHA}/priority`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe('merge queue priority is an admin label', () => {
  let dir: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-queue-priority-'));
    const db = await import('../db.js');
    db.resetDbForTest();
    db.initDb(path.join(dir, 'test.db'));
  });
  afterEach(async () => {
    (await import('../db.js')).resetDbForTest();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a developer (every agent seat is one) gets 403 and nothing is written; an admin sets it', async () => {
    const { createAuthMiddleware } = await import('../auth.js');
    const { registerReviewRoutes } = await import('./reviews.js');
    const mergeQueue = await import('../merge-queue.js');
    const set = vi.spyOn(mergeQueue, 'setQueuePriority').mockReturnValue({ sha: SHA, priority: 7 } as never);
    const app = new Hono<import('../auth.js').NodeAppEnv>();
    const cfg = { auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] } } as unknown as WaveConfig;
    app.use('/api/*', createAuthMiddleware(() => cfg));
    registerReviewRoutes(app);

    const dev = (await import('../users.js')).createUser({ name: 'codex3', role: 'developer' });
    if (!dev.ok) throw new Error(dev.error);
    const refused = await call(app, dev.data.token, { priority: 9 });
    expect(refused.status).toBe(403);
    expect(set).not.toHaveBeenCalled();

    const admin = await call(app, FALLBACK, { priority: 7 });
    expect(admin.status).toBe(200);
    expect(set).toHaveBeenCalledWith(SHA, 7);

    // requeue of a bounced lane is an admin action too, with a reason, written as an event by the module
    const rq = vi.spyOn(mergeQueue, 'requeueBounced').mockReturnValue({ ok: false, error: 'queue row is merged, not bounced' });
    const post = (token: string, body: unknown) => app.request(`/api/merge-queue/${SHA}/requeue`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post(dev.data.token, { reason: 'tool exit 5 after GREEN' })).status).toBe(403);
    expect(rq).not.toHaveBeenCalled();
    expect((await post(FALLBACK, { reason: 'x' })).status).toBe(400);
    expect((await post(FALLBACK, { reason: 'tool exit 5 after GREEN' })).status).toBe(409);
    expect(rq).toHaveBeenCalledWith(SHA, 'tool exit 5 after GREEN', 'owner');

    // reset names its states or is refused: no default widening
    const reset = vi.spyOn(mergeQueue, 'resetQueue').mockReturnValue({ reset: [], untouched: {} } as never);
    vi.spyOn(await import('../config.js'), 'getConfig').mockReturnValue({ projects: { wave: {} } } as never);
    const resetPost = (body: unknown) => app.request('/api/merge-queue/wave/reset', { method: 'POST', headers: { Authorization: `Bearer ${FALLBACK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await resetPost({ reason: 'queue reset: merge main, gate, refreeze' })).status).toBe(400);
    expect(reset).not.toHaveBeenCalled();
    expect((await resetPost({ reason: 'queue reset: merge main, gate, refreeze', states: ['bounced'] })).status).toBe(200);
    expect(reset).toHaveBeenCalledWith('wave', 'queue reset: merge main, gate, refreeze', 'owner', ['bounced']);
  });
});
