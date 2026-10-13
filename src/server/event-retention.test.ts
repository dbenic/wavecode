import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ events: { short_hours: 24, retention_days: 90 } })) }));
vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

describe('event retention', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-retention-')); });
  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('drops pane-output ticks older than a day and everything older than the retention, keeps the rest', async () => {
    const db = await import('./db.js');
    const handle = db.initDb(path.join(tmp, 'r.db'));
    const now = Date.parse('2026-10-13T12:00:00Z');
    const stamp = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const ins = handle.prepare("INSERT INTO events (type, entity_type, entity_id, payload_json, created_at) VALUES (?, 'agent', 'a', '{}', ?)");
    ins.run('agent.output_updated', stamp(2));        // keep: fresh tick
    ins.run('agent.output_updated', stamp(30));       // drop: tick older than 24 h
    ins.run('queue.empty', stamp(48));                // drop: short-lived
    ins.run('run.finished', stamp(30));               // keep: normal event, young
    ins.run('run.finished', stamp(91 * 24));          // drop: older than 90 days
    ins.run('pipeline.gate', stamp(89 * 24));         // keep: within retention
    const { pruneEvents, storageSnapshot } = await import('./event-retention.js');
    const before = storageSnapshot();
    expect(before.events).toBe(6);
    expect(before.events_short_lived).toBe(3);
    const result = pruneEvents(now);
    expect(result).toEqual({ short_lived: 2, expired: 1 });
    const left = (handle.prepare('SELECT type, created_at FROM events ORDER BY id').all() as Array<{ type: string }>).map((r) => r.type);
    expect(left).toEqual(['agent.output_updated', 'run.finished', 'pipeline.gate']);
    expect(storageSnapshot().db_bytes).toBeGreaterThan(0);
    expect(pruneEvents(now)).toEqual({ short_lived: 0, expired: 0 });
  });
});
