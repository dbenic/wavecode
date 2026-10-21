/**
 * The events table is the daemon's journal and the SSE replay log. Pane
 * output ticks are most of it (tens of thousands a day) and nothing reads
 * them back after a day; everything else is kept for `retention_days`.
 * One pass at startup, then every six hours. Row ids keep increasing, so a
 * browser's Last-Event-ID stays valid.
 */

import { getConfig } from './config.js';
import { getDb } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { recordJob } from './perf-monitor.js';

export const PRUNE_EVERY_MS = 6 * 60 * 60_000;
export const DEFAULT_SHORT_LIVED_TYPES = ['agent.output_updated', 'queue.empty', 'tests.portal'];

export interface EventRetention {
  /** event types kept only `short_hours` (default: pane output ticks, queue.empty) */
  short_lived_types: string[];
  short_hours: number;
  retention_days: number;
}

export function retentionConfig(): EventRetention {
  const cfg = getConfig().events;
  return {
    short_lived_types: cfg?.short_lived_types ?? DEFAULT_SHORT_LIVED_TYPES,
    short_hours: cfg?.short_hours ?? 24,
    retention_days: cfg?.retention_days ?? 90,
  };
}

function sqliteStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export interface PruneResult { short_lived: number; expired: number }

/** Delete what is past its retention. Batched so a big first run does not hold the write lock for long. */
export function pruneEvents(now = Date.now(), retention = retentionConfig()): PruneResult {
  const db = getDb();
  const started = Date.now();
  let shortLived = 0;
  let expired = 0;
  const BATCH = 5000;
  if (retention.short_lived_types.length > 0 && retention.short_hours > 0) {
    const cutoff = sqliteStamp(now - retention.short_hours * 3600_000);
    const marks = retention.short_lived_types.map(() => '?').join(', ');
    const stmt = db.prepare(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE type IN (${marks}) AND created_at < ? LIMIT ${BATCH})`);
    for (;;) {
      const n = stmt.run(...retention.short_lived_types, cutoff).changes;
      shortLived += n;
      if (n < BATCH) break;
    }
  }
  if (retention.retention_days > 0) {
    const cutoff = sqliteStamp(now - retention.retention_days * 86400_000);
    const stmt = db.prepare(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < ? LIMIT ${BATCH})`);
    for (;;) {
      const n = stmt.run(cutoff).changes;
      expired += n;
      if (n < BATCH) break;
    }
  }
  const ms = Date.now() - started;
  recordJob('event_prune', ms);
  if (shortLived + expired > 0) {
    logger.info({ short_lived: shortLived, expired, ms }, 'Events pruned');
    emit('events.pruned', 'system', 'events', { short_lived: shortLived, expired, ms }, null);
  }
  return { short_lived: shortLived, expired };
}

export interface StorageSnapshot {
  events: number;
  events_short_lived: number;
  freezes: number;
  tasks: number;
  runs: number;
  db_bytes: number | null;
}

/** Row counts the Health panel shows next to the timings. */
export function storageSnapshot(): StorageSnapshot {
  const db = getDb();
  const count = (sql: string, params: unknown[] = []): number => {
    try { return (db.prepare(sql).get(...params) as { n: number }).n; } catch { return 0; }
  };
  const types = retentionConfig().short_lived_types;
  const marks = types.map(() => '?').join(', ');
  let dbBytes: number | null = null;
  try {
    const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
    dbBytes = pageCount * pageSize;
  } catch { dbBytes = null; }
  return {
    events: count('SELECT COUNT(*) AS n FROM events'),
    events_short_lived: types.length ? count(`SELECT COUNT(*) AS n FROM events WHERE type IN (${marks})`, types) : 0,
    freezes: count('SELECT COUNT(*) AS n FROM release_freezes'),
    tasks: count('SELECT COUNT(*) AS n FROM tasks'),
    runs: count('SELECT COUNT(*) AS n FROM runs'),
    db_bytes: dbBytes,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;

export function startEventRetention(): void {
  if (timer) return;
  const run = () => { try { pruneEvents(); } catch (e) { logger.warn({ error: (e as Error).message }, 'Event prune failed'); } };
  firstRun = setTimeout(run, 30_000);
  firstRun.unref?.();
  timer = setInterval(run, PRUNE_EVERY_MS);
  timer.unref?.();
}

export function stopEventRetention(): void {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
}
