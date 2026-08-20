/**
 * Phase 2 Tests — db.ts (schema migrations, CRUD operations)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from './db.js';

describe('db.ts — schema migrations', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-db-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    // Reset module cache so each test gets a fresh db singleton
    const { resetDbForTest } = await import('./db.js');
    if (typeof resetDbForTest === 'function') resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates all tables on fresh database', async () => {
    const mod = await import('./db.js');
    const db = mod.initDb(dbPath);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('agents');
    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('runs');
    expect(tableNames).toContain('events');
    expect(tableNames).toContain('artifacts');
    expect(tableNames).toContain('push_subscriptions');
    expect(tableNames).toContain('kv_settings');
    expect(tableNames).toContain('decisions');
    expect(tableNames).toContain('goals');

    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    expect(taskColumns.map((c) => c.name)).toContain('goal_id');

    // Schema version should be current
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('runs incremental migrations on existing database', async () => {
    // Create a v1 database manually (no kv_settings, no push_subscriptions)
    const rawDb = new Database(dbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, runtime TEXT, tmux_session TEXT, workspace TEXT, mode TEXT DEFAULT 'adopted', status TEXT DEFAULT 'idle', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE tasks (id TEXT PRIMARY KEY, agent_id TEXT, prompt TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, attempt INTEGER DEFAULT 1, status TEXT DEFAULT 'running', started_at TEXT DEFAULT (datetime('now')), finished_at TEXT, exit_code INTEGER, transcript_path TEXT, review_status TEXT DEFAULT 'pending');
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, entity_type TEXT, entity_id TEXT, payload_json TEXT, created_at TEXT DEFAULT (datetime('now')));
    `);
    rawDb.pragma('user_version = 1');
    rawDb.close();

    // Now init with migrations
    const mod = await import('./db.js');
    const db = mod.initDb(dbPath);

    // Check that new tables were created by migrations
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('push_subscriptions');
    expect(tableNames).toContain('kv_settings');
    expect(tableNames).toContain('decisions');
    expect(tableNames).toContain('goals');

    // Check that changed_files column was added to runs
    const columns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    expect(columns.map(c => c.name)).toContain('changed_files');
    expect(columns.map(c => c.name)).toContain('result_path');

    // Check that model/effort pin columns were added to agents (v8 → v9)
    const agentColumns = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    expect(agentColumns.map(c => c.name)).toContain('model');
    expect(agentColumns.map(c => c.name)).toContain('effort');

    const migratedTaskColumns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    expect(migratedTaskColumns.map((c) => c.name)).toContain('goal_id');

    // Version should be bumped
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('stores and updates model/effort pins on agents', async () => {
    const mod = await import('./db.js');
    mod.initDb(dbPath);

    const created = mod.insertAgent({
      name: 'pinned-agent',
      runtime: 'claude-code',
      tmux_session: 'wc-pinned',
      workspace: null,
      mode: 'spawned',
      status: 'idle',
      model: 'claude-opus-5',
      effort: 'xhigh',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.model).toBe('claude-opus-5');
    expect(created.data.effort).toBe('xhigh');

    // Unpinned agents default to null
    const plain = mod.insertAgent({
      name: 'plain-agent',
      runtime: 'codex',
      tmux_session: 'wc-plain',
      workspace: null,
      mode: 'adopted',
      status: 'idle',
    });
    expect(plain.ok && plain.data.model === null && plain.data.effort === null).toBe(true);

    // Partial update: only effort changes
    const updated = mod.updateAgentPin(created.data.id, { effort: 'high' });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.data.model).toBe('claude-opus-5');
      expect(updated.data.effort).toBe('high');
    }

    // null clears a pin
    const cleared = mod.updateAgentPin(created.data.id, { model: null });
    expect(cleared.ok && cleared.data.model === null).toBe(true);

    // Unknown agent
    const missing = mod.updateAgentPin('nope', { model: 'x' });
    expect(missing.ok).toBe(false);
  });

  it('CRUD operations work after migration', async () => {
    const mod = await import('./db.js');
    mod.initDb(dbPath);

    // Insert agent
    const result = mod.insertAgent({
      name: 'test-agent',
      runtime: 'claude-code',
      tmux_session: 'test-session',
      workspace: tmpDir,
      mode: 'adopted',
      status: 'idle',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('test-agent');
    }

    // List agents
    const agents = mod.listAgents();
    expect(agents.length).toBe(1);

    // Insert task
    const taskResult = mod.insertTask({ prompt: 'test task', priority: 5 });
    expect(taskResult.ok).toBe(true);

    // Insert run records a stable result_path
    const runResult = mod.insertRun({
      task_id: taskResult.ok ? taskResult.data.id : 'missing',
      agent_id: agents[0].id,
    });
    expect(runResult.ok).toBe(true);
    if (runResult.ok) {
      expect(runResult.data.result_path).toContain(path.join('runs', runResult.data.id, 'result.txt'));
      expect(runResult.data.result_path).not.toContain(`${path.sep}.wavecode${path.sep}`);
    }

    // Insert event
    const eventResult = mod.insertEvent({
      type: 'test.event',
      entity_type: 'agent',
      entity_id: agents[0].id,
      payload: { test: true },
    });
    expect(eventResult.ok).toBe(true);
  });

  it('finishRun is write-once; reconcileFailedRunToPass can flip idle-close FAIL to done', async () => {
    const mod = await import('./db.js');
    mod.initDb(dbPath);

    const agent = mod.insertAgent({
      name: 'late-pass-agent',
      runtime: 'claude-code',
      tmux_session: 'wc-late',
      workspace: tmpDir,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;

    const task = mod.insertTask({ prompt: 'review', agent_id: agent.data.id });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    const run = mod.insertRun({ task_id: task.data.id, agent_id: agent.data.id });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    const failed = mod.finishRun(run.data.id, 1);
    expect(failed.ok && failed.data.status === 'failed' && failed.data.exit_code === 1).toBe(true);
    const finishedAt = failed.ok ? failed.data.finished_at : null;

    const ignored = mod.finishRun(run.data.id, 0);
    expect(ignored.ok && ignored.data.status === 'failed' && ignored.data.exit_code === 1).toBe(true);

    const reconciled = mod.reconcileFailedRunToPass(run.data.id);
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) {
      expect(reconciled.data.status).toBe('done');
      expect(reconciled.data.exit_code).toBe(0);
      expect(reconciled.data.finished_at).toBe(finishedAt);
    }

    const alreadyDone = mod.reconcileFailedRunToPass(run.data.id);
    expect(alreadyDone.ok && alreadyDone.data.status === 'done').toBe(true);
  });
});
