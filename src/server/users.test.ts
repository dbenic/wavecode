/**
 * Identity (multi-orchestrator spec §1): users table, token hashing,
 * migration v11 → v12, and actor attribution on events.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

describe('users.ts — identity', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-users-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    const { initDb, resetDbForTest } = await import('./db.js');
    resetDbForTest();
    initDb(dbPath);
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a user, returns the token once, and stores only its sha256', async () => {
    const { createUser, hashToken } = await import('./users.js');
    const { getDb } = await import('./db.js');

    const result = createUser({ name: 'Ana', role: 'developer' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { user, token } = result.data;
    expect(user.name).toBe('ana');
    expect(user.role).toBe('developer');
    expect(user.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(user).not.toHaveProperty('token_hash');
    expect(token).toMatch(/^wc_[A-Za-z0-9_-]{40,}$/);

    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(user.id) as Record<string, string>;
    expect(row.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('defaults role to developer and validates name, role, and color', async () => {
    const { createUser } = await import('./users.js');

    const dev = createUser({ name: 'marko' });
    expect(dev.ok && dev.data.user.role).toBe('developer');

    expect(createUser({ name: '' }).ok).toBe(false);
    expect(createUser({ name: 'has space' }).ok).toBe(false);
    expect(createUser({ name: 'owner' })).toEqual({ ok: false, error: "name 'owner' is reserved" });
    expect(createUser({ name: 'zed', role: 'root' }).ok).toBe(false);
    expect(createUser({ name: 'zed', color: 'red' }).ok).toBe(false);

    const colored = createUser({ name: 'zed', color: '#ABCDEF', role: 'observer' });
    expect(colored.ok && colored.data.user.color).toBe('#abcdef');
    expect(colored.ok && colored.data.user.role).toBe('observer');

    expect(createUser({ name: 'zed' })).toEqual({ ok: false, error: "User 'zed' already exists" });
  });

  it('resolves tokens: fallback → synthetic owner admin, user token → user, unknown → null', async () => {
    const { createUser, resolveUserByToken, OWNER_USER } = await import('./users.js');
    const created = createUser({ name: 'ana' });
    if (!created.ok) throw new Error(created.error);

    expect(resolveUserByToken('fallback-secret', 'fallback-secret')).toEqual(OWNER_USER);
    expect(OWNER_USER.role).toBe('admin');
    expect(resolveUserByToken(created.data.token, 'fallback-secret')?.id).toBe(created.data.user.id);
    expect(resolveUserByToken(created.data.token, null)?.name).toBe('ana');
    expect(resolveUserByToken('nope', 'fallback-secret')).toBeNull();
    expect(resolveUserByToken(null, 'fallback-secret')).toBeNull();
  });

  it('revokes users so their token stops resolving; owner cannot be revoked', async () => {
    const { createUser, resolveUserByToken, revokeUser } = await import('./users.js');
    const created = createUser({ name: 'ana' });
    if (!created.ok) throw new Error(created.error);

    expect(revokeUser(created.data.user.id).ok).toBe(true);
    expect(resolveUserByToken(created.data.token, null)).toBeNull();
    expect(revokeUser(created.data.user.id).ok).toBe(false);
    expect(revokeUser('owner').ok).toBe(false);
  });

  it('role helpers: observers cannot mutate, only admins are admin', async () => {
    const { canMutate, isAdmin } = await import('./users.js');
    expect(canMutate({ role: 'observer' })).toBe(false);
    expect(canMutate({ role: 'developer' })).toBe(true);
    expect(isAdmin({ role: 'developer' })).toBe(false);
    expect(isAdmin({ role: 'admin' })).toBe(true);
  });
});

describe('events.actor_id — attribution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-actor-test-'));
    const { initDb, resetDbForTest } = await import('./db.js');
    resetDbForTest();
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emit() records an explicit actor (id or user object) and null for system', async () => {
    const { emit } = await import('./event-bus.js');
    expect(emit('task.created', 'task', 't1', {}, 'user-1')?.actor_id).toBe('user-1');
    expect(emit('task.created', 'task', 't2', {}, { id: 'user-2' })?.actor_id).toBe('user-2');
    expect(emit('task.created', 'task', 't3')?.actor_id).toBeNull();
    expect(emit('task.created', 'task', 't4', {}, null)?.actor_id).toBeNull();
  });

  it('emit() defaults to the in-flight request actor, and an explicit null overrides it', async () => {
    const { emit } = await import('./event-bus.js');
    const { runWithActor, currentActorId } = await import('./request-context.js');

    await runWithActor('ana', async () => {
      await Promise.resolve();
      expect(currentActorId()).toBe('ana');
      expect(emit('agent.prompt_sent', 'agent', 'a1')?.actor_id).toBe('ana');
      expect(emit('agent.status', 'agent', 'a1', {}, null)?.actor_id).toBeNull();
      expect(emit('agent.status', 'agent', 'a1', {}, 'bob')?.actor_id).toBe('bob');
    });
    expect(currentActorId()).toBeNull();
  });

  it('timers created during a request are attributed to system once the request ends', async () => {
    const { emit } = await import('./event-bus.js');
    const { runWithActor } = await import('./request-context.js');

    let fire: (() => void) | null = null;
    const fired = new Promise<number | null | string>((resolve) => {
      fire = () => resolve(emit('agent.status', 'agent', 'a1')?.actor_id ?? null);
    });
    await runWithActor('ana', async () => {
      setTimeout(() => fire?.(), 5);
    });
    expect(await fired).toBeNull();
  });

  it('includes actorId in the SSE payload', async () => {
    const { emit, subscribe, unsubscribe } = await import('./event-bus.js');
    const messages: string[] = [];
    const writer = { id: 'w', write: (d: string) => messages.push(d), close: () => {} };
    subscribe(writer);
    emit('task.created', 'task', 't1', {}, 'ana');
    unsubscribe(writer);
    const data = JSON.parse(messages[0].split('data: ')[1]);
    expect(data.actorId).toBe('ana');
  });
});

describe('migration v11 → current', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-mig12-test-'));
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds the users table and events.actor_id while keeping existing events', async () => {
    const dbPath = path.join(tmpDir, 'v11.db');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO events (type, entity_type, entity_id) VALUES ('run.started', 'run', 'r1');
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, tmux_session TEXT NOT NULL, workspace TEXT, mode TEXT NOT NULL DEFAULT 'adopted', status TEXT NOT NULL DEFAULT 'idle', model TEXT, effort TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', workspace TEXT, external_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE tasks (id TEXT PRIMARY KEY, agent_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), goal_id TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, exit_code INTEGER, transcript_path TEXT, review_status TEXT NOT NULL DEFAULT 'pending', changed_files TEXT, result_path TEXT);
      CREATE TABLE agent_messages (id TEXT PRIMARY KEY, from_agent_id TEXT, to_agent_id TEXT, workspace TEXT, message TEXT NOT NULL, message_type TEXT NOT NULL DEFAULT 'info', ref_task_id TEXT, ref_run_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    `);
    raw.pragma('user_version = 11');
    raw.close();

    const mod = await import('./db.js');
    mod.resetDbForTest();
    const db = mod.initDb(dbPath);

    expect(db.pragma('user_version', { simple: true })).toBe(mod.SCHEMA_VERSION);
    const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    expect(userCols).toEqual(expect.arrayContaining(['id', 'name', 'role', 'color', 'token_hash', 'created_at']));

    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('agents')).toEqual(expect.arrayContaining(['owner_id', 'lease_expires_at', 'lease_reason']));
    expect(cols('tasks')).toContain('created_by');
    expect(cols('goals')).toContain('created_by');
    expect(cols('users')).toContain('profile');
    expect(cols('agents')).toContain('profile');
    // v15 (spec §5b): reply capture + orchestrator seat
    expect(cols('agents')).toContain('role');
    expect(cols('runs')).toContain('summary');
    expect(cols('agent_messages')).toEqual(expect.arrayContaining(['ref_prompt_actor', 'ref_prompt_event_id', 'truncated']));

    const events = mod.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBeNull();
    expect(mod.insertEvent({ type: 'x', entity_type: 'task', entity_id: 't', actor_id: 'ana' }).ok).toBe(true);
    expect(mod.listEvents({ since_id: events[0].id })[0].actor_id).toBe('ana');
  });
});
