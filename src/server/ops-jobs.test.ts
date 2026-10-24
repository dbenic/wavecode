import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAIM_SQL, STAGE_STEPS, checkReceiptPaths, claimOpsJob, insertOpsJob, stagePayload } from './ops-jobs.js';
import { boundOpsRole, resolveOpsLanes } from './ops-lanes-config.js';

const requireFrom = fileURLToPath(import.meta.url);

function claimInWorker(file: string, role: string, who: string): Promise<{ id?: string; status?: string } | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { createRequire } = require('node:module');
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = createRequire(workerData.requireFrom)('better-sqlite3');
      const db = new Database(workerData.file);
      db.pragma('busy_timeout = 5000');
      try {
        const row = db.prepare(workerData.sql).get(workerData.who, new Date().toISOString(), workerData.role) || null;
        parentPort.postMessage({ row });
      } catch (error) {
        parentPort.postMessage({ error: String(error && error.message || error) });
      } finally {
        db.close();
      }
    `, {
      eval: true,
      workerData: { file, sql: CLAIM_SQL, role, who, requireFrom },
    });
    worker.on('message', (message: { row: { id?: string; status?: string } | null; error?: string }) => {
      if (message.error) reject(new Error(message.error));
      else resolve(message.row);
    });
    worker.on('error', reject);
  });
}

describe('ops jobs store', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ops-jobs-'));
    dbPath = path.join(dir, 'test.db');
    const db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(dbPath);
  });

  afterEach(async () => {
    const db = await import('./db.js');
    db.resetDbForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bumps the schema and creates ops_jobs', async () => {
    const db = await import('./db.js');
    expect(db.SCHEMA_VERSION).toBeGreaterThanOrEqual(28);
    const version = db.getDb().pragma('user_version', { simple: true });
    expect(version).toBe(db.SCHEMA_VERSION);
    const columns = db.getDb().prepare('PRAGMA table_xinfo(ops_jobs)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id', 'kind', 'role', 'status', 'requester', 'payload_json', 'created_at',
      'claimed_by', 'claimed_at', 'finished_at', 'receipt_paths_json', 'approval_by', 'approval_at',
      'stage_sha',
    ]));
    const index = db.getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_ops_jobs_open_stage'").get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/UNIQUE/i);
    expect(index?.sql).toMatch(/queued/);
    expect(index?.sql).toMatch(/claimed/);
  });

  it('claims the oldest queued job for that role only', () => {
    const older = insertOpsJob({
      kind: 'ask_data', role: 'scout', status: 'queued', requester: 'denis',
      payload: { company: 'hipsl' }, createdAt: '2026-10-24T10:00:00.000Z',
    });
    insertOpsJob({
      kind: 'ask_data', role: 'scout', status: 'queued', requester: 'denis',
      payload: { company: 'clients' }, createdAt: '2026-10-24T11:00:00.000Z',
    });
    insertOpsJob({
      kind: 'stage', role: 'stager', status: 'queued', requester: 'denis',
      payload: stagePayload('a'.repeat(40)), createdAt: '2026-10-24T09:00:00.000Z',
    });
    const first = claimOpsJob('scout', 'user-scout');
    const second = claimOpsJob('scout', 'user-scout');
    expect(first?.id).toBe(older.id);
    expect(second?.payload).toMatchObject({ company: 'clients' });
    expect(claimOpsJob('scout', 'user-scout')).toBeNull();
    expect(claimOpsJob('stager', 'user-stager')?.role).toBe('stager');
  });

  it('two pullers cannot claim the same job', async () => {
    const job = insertOpsJob({
      kind: 'stage', role: 'stager', status: 'queued', requester: 'denis',
      payload: stagePayload('d'.repeat(40)),
    });
    const db = await import('./db.js');
    db.resetDbForTest();
    const [left, right] = await Promise.all([
      claimInWorker(dbPath, 'stager', 'puller-a'),
      claimInWorker(dbPath, 'stager', 'puller-b'),
    ]);
    const winners = [left, right].filter((row) => row && row.id === job.id);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.status).toBe('claimed');
    const check = new Database(dbPath);
    const rows = check.prepare('SELECT status, claimed_by FROM ops_jobs').all() as { status: string; claimed_by: string }[];
    check.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('claimed');
    expect(['puller-a', 'puller-b']).toContain(rows[0].claimed_by);
  });

  it('stores a receipt only when realpath stays inside the role directory', async () => {
    const root = path.join(dir, 'receipts');
    const roleDir = path.join(root, 'stager');
    const outside = path.join(dir, 'secret.txt');
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(path.join(roleDir, 'done.txt'), 'BODY_SHOULD_NOT_BE_STORED');
    fs.writeFileSync(outside, 'OUTSIDE_SECRET');
    fs.symlinkSync(outside, path.join(roleDir, 'leak.txt'));

    const good = await checkReceiptPaths('stager', [path.join(roleDir, 'done.txt')], root);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.paths).toEqual([await fs.promises.realpath(path.join(roleDir, 'done.txt'))]);
      expect(JSON.stringify(good.paths)).not.toContain('BODY_SHOULD_NOT_BE_STORED');
    }

    const traversal = await checkReceiptPaths('stager', [path.join(roleDir, '..', '..', 'secret.txt')], root);
    expect(traversal.ok).toBe(false);
    const link = await checkReceiptPaths('stager', [path.join(roleDir, 'leak.txt')], root);
    expect(link.ok).toBe(false);
    expect(JSON.stringify(link)).not.toContain('OUTSIDE_SECRET');
  });

  it('binds a puller to one role, and keeps stage steps as names', () => {
    const defaults = resolveOpsLanes(undefined);
    expect(boundOpsRole({ name: 'stager' }, defaults)).toBe('stager');
    expect(boundOpsRole({ name: 'scout' }, defaults)).toBe('scout');
    expect(boundOpsRole({ name: 'denis' }, defaults)).toBeNull();
    expect(boundOpsRole({ name: 'stager', via_seat: true }, defaults)).toBeNull();
    const listed = resolveOpsLanes({ ops_lanes: { pullers: [{ user: 'bot-a', role: 'stager' }] } });
    expect(boundOpsRole({ name: 'bot-a' }, listed)).toBe('stager');
    expect(boundOpsRole({ name: 'stager' }, listed)).toBeNull();
    const payload = stagePayload('A'.repeat(40));
    expect(payload.steps).toEqual([...STAGE_STEPS]);
    expect(payload.steps.every((step) => /^[a-z0-9-]+$/.test(step))).toBe(true);
    expect(payload.sha).toBe('a'.repeat(40));
  });

  it('does not launch an opsbots script from the job store', () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ['ops-jobs.ts', 'ops-stage.ts', 'ops-ask.ts', 'routes/ops-jobs.ts']) {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      expect(src).not.toMatch(/child_process|execFile|spawn\(/);
    }
  });
});
