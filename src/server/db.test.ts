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

    // Check that changed_files column was added to runs
    const columns = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
    expect(columns.map(c => c.name)).toContain('changed_files');

    // Version should be bumped
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('CRUD operations work after migration', async () => {
    const mod = await import('./db.js');
    mod.initDb(dbPath);

    // Insert agent
    const result = mod.insertAgent({
      name: 'test-agent',
      runtime: 'claude-code',
      tmux_session: 'test-session',
      workspace: null,
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

    // Insert event
    const eventResult = mod.insertEvent({
      type: 'test.event',
      entity_type: 'agent',
      entity_id: agents[0].id,
      payload: { test: true },
    });
    expect(eventResult.ok).toBe(true);
  });
});
