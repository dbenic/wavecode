import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveConfig } from './config.js';
import { resolveOpsLanes } from './ops-lanes-config.js';

const run = promisify(execFile);
const SCRIPT = path.resolve(__dirname, '../../scripts/ops-e2e.sh');
const SHA = 'c'.repeat(40);

describe('scripts/ops-e2e.sh', () => {
  let dir: string;
  let server: ReturnType<typeof serve>;
  let base: string;
  let devFile: string;
  let stagerFile: string;
  let tokens: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ops-e2e-'));
    const db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(dir, 'test.db'));
    (await import('./ops-jobs.js')).setOpsLanesForTest(resolveOpsLanes({ ops_lanes: { receipts_root: path.join(dir, 'receipts') } }));
    vi.restoreAllMocks();
    vi.spyOn(await import('./ops-stage.js'), 'opsStageRefusal').mockResolvedValue(null);
    const users = await import('./users.js');
    const dev = users.createUser({ name: 'ana', role: 'developer' });
    const stager = users.createUser({ name: 'stager', role: 'opsbot' });
    if (!dev.ok || !stager.ok) throw new Error('user setup');
    tokens = [dev.data.token, stager.data.token];
    devFile = path.join(dir, 'dev.token'); fs.writeFileSync(devFile, dev.data.token + '\n', { mode: 0o600 });
    stagerFile = path.join(dir, 'stager.token'); fs.writeFileSync(stagerFile, stager.data.token, { mode: 0o600 });

    const { createAuthMiddleware } = await import('./auth.js');
    const { registerOpsJobRoutes } = await import('./routes/ops-jobs.js');
    const app = new Hono<import('./auth.js').NodeAppEnv>();
    const cfg = { auth: { method: 'token', fallback_token: 'fb-secret', trusted_proxies: [] } } as unknown as WaveConfig;
    app.use('/api/*', createAuthMiddleware(() => cfg));
    registerOpsJobRoutes(app);
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (await import('./ops-jobs.js')).setOpsLanesForTest(null);
    (await import('./db.js')).resetDbForTest();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const args = (extra: string[]) => ['--base-url', base, '--dev-token-file', devFile, '--stager-token-file', stagerFile,
    '--sha', SHA, '--receipt-dir', path.join(dir, 'receipts', 'stager'), ...extra];

  it('passes every step in dry-run and never prints a token', async () => {
    const { stdout, stderr } = await run('bash', [SCRIPT, ...args(['--dry-run'])], { timeout: 20000 });
    for (const step of ['create-stage-job', 'cross-role-claim-403', 'stager-claim', 'fixed-steps', 'step:deploy', 'write-receipt', 'complete', 'final-state']) {
      expect(stdout).toMatch(new RegExp(`^PASS ${step}`, 'm'));
    }
    expect(stdout).not.toMatch(/^FAIL/m);
    expect(stdout).toMatch(/RESULT PASS/);
    for (const t of tokens) expect(stdout + stderr).not.toContain(t);
    const jobs = (await import('./ops-jobs.js')).listOpsJobs();
    expect(jobs[0]).toMatchObject({ status: 'done', role: 'stager' });
    expect(jobs[0].receipt_paths).toHaveLength(1);
  });

  it('runs real steps through the step runner and fails the job when one fails', async () => {
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, '#!/usr/bin/env bash\n[ "$1" = stg-backup ] && exit 3\nexit 0\n', { mode: 0o755 });
    const err = await run('bash', [SCRIPT, ...args(['--step-runner', runner])], { timeout: 20000 }).catch((e) => e as { code: number; stdout: string });
    expect((err as { code: number }).code).toBe(1);
    const out = (err as { stdout: string }).stdout;
    expect(out).toMatch(/^PASS step:stg-quiet-check/m);
    expect(out).toMatch(/^FAIL step:stg-backup/m);
    expect(out).not.toMatch(/step:deploy/);
    expect(out).toMatch(/^PASS final-state — failed/m);
    expect(out).toMatch(/RESULT FAIL/);
    expect((await import('./ops-jobs.js')).listOpsJobs()[0].status).toBe('failed');
  });

  it('refuses to run without a token file or a mode', async () => {
    const e1 = await run('bash', [SCRIPT, '--base-url', base, '--dev-token-file', '/nope', '--stager-token-file', stagerFile, '--sha', SHA, '--receipt-dir', dir, '--dry-run']).catch((e) => e as { code: number; stdout: string });
    expect((e1 as { code: number }).code).toBe(1);
    expect((e1 as { stdout: string }).stdout).toMatch(/^FAIL args/m);
    const e2 = await run('bash', [SCRIPT, ...args([])]).catch((e) => e as { code: number; stdout: string });
    expect((e2 as { stdout: string }).stdout).toMatch(/step-runner or --dry-run/);
  });
});
