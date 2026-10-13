/**
 * One-time admin purge of review runs that nobody touched.
 * Pending runs older than 7 days with no code_reviews row are marked
 * abandoned. The run row stays, so the history is still there.
 */

import { ensureReviewTable } from './code-review.js';
import { getDb, type Run } from './db.js';
import { emit } from './event-bus.js';

export interface PurgeResult {
  abandoned: string[];
  dry_run: boolean;
  days: number;
}

/** SQLite `datetime('now')` shape, `days` before `now`. */
function cutoffSql(now: number, days: number): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

export function purgeStalePendingReviews(opts?: { now?: number; days?: number; dryRun?: boolean }): PurgeResult {
  const days = opts?.days ?? 7;
  const dryRun = opts?.dryRun === true;
  ensureReviewTable();
  const cutoff = cutoffSql(opts?.now ?? Date.now(), days);
  const rows = getDb().prepare(
    `SELECT id FROM runs
     WHERE status = 'done' AND review_status = 'pending'
       AND finished_at IS NOT NULL AND finished_at < ?
       AND NOT EXISTS (SELECT 1 FROM code_reviews c WHERE c.run_id = runs.id)`,
  ).all(cutoff) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  if (!dryRun && ids.length > 0) {
    const update = getDb().prepare("UPDATE runs SET review_status = 'abandoned' WHERE id = ? AND review_status = 'pending'");
    const tx = getDb().transaction((runIds: string[]) => {
      for (const id of runIds) update.run(id);
    });
    tx(ids);
    emit('review.abandoned', 'run', 'purge', { count: ids.length, ids, days }, null);
  }
  return { abandoned: ids, dry_run: dryRun, days };
}

export function reviewStatusOf(id: string): Run['review_status'] | null {
  const row = getDb().prepare('SELECT review_status FROM runs WHERE id = ?').get(id) as { review_status: Run['review_status'] } | undefined;
  return row?.review_status ?? null;
}
