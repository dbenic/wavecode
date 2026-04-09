/**
 * Phase 3 Tests — event-bus.ts (memory safety, subscriber management)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('event-bus.ts — reliability', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-bus-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    // Fresh DB for each test
    const { initDb, resetDbForTest } = await import('./db.js');
    resetDbForTest();
    initDb(dbPath);
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits events to subscribers and formats SSE correctly', async () => {
    const { emit, subscribe, unsubscribe, getSubscriberCount } = await import('./event-bus.js');

    const messages: string[] = [];
    const writer = {
      id: 'test-1',
      write: (data: string) => messages.push(data),
      close: () => {},
    };

    subscribe(writer);
    expect(getSubscriberCount()).toBe(1);

    const event = emit('test.event', 'agent', 'agent-1', { foo: 'bar' });
    expect(event).not.toBeNull();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('event: test.event');
    expect(messages[0]).toContain('"foo":"bar"');

    unsubscribe(writer);
    expect(getSubscriberCount()).toBe(0);
  });

  it('removes dead subscribers that throw on write', async () => {
    const { emit, subscribe, getSubscriberCount } = await import('./event-bus.js');

    const deadWriter = {
      id: 'dead-1',
      write: () => { throw new Error('Connection reset'); },
      close: () => {},
    };

    const aliveWriter = {
      id: 'alive-1',
      write: () => {},
      close: () => {},
    };

    subscribe(deadWriter);
    subscribe(aliveWriter);
    expect(getSubscriberCount()).toBe(2);

    // Emit should remove the dead writer without crashing
    emit('test.event', 'agent', 'agent-1', {});
    expect(getSubscriberCount()).toBe(1);
  });
});
