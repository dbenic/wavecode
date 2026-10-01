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

describe('migration v11 → v12', () => {
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
    `);
    raw.pragma('user_version = 11');
    raw.close();

    const mod = await import('./db.js');
    mod.resetDbForTest();
    const db = mod.initDb(dbPath);

    expect(db.pragma('user_version', { simple: true })).toBe(mod.SCHEMA_VERSION);
    const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    expect(userCols).toEqual(expect.arrayContaining(['id', 'name', 'role', 'color', 'token_hash', 'created_at']));

    const events = mod.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBeNull();
    expect(mod.insertEvent({ type: 'x', entity_type: 'task', entity_id: 't', actor_id: 'ana' }).ok).toBe(true);
    expect(mod.listEvents({ since_id: events[0].id })[0].actor_id).toBe('ana');
  });
});
