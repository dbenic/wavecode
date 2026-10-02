/**
 * Per-template metrics for a room (spec §5f.2): how well each dispatch
 * template works, measured from what already happened — reviews, runs and
 * the questions agents sent back.
 *
 *   first_pass_rate   tasks whose fix-round-0 review verdict was PASS / reviewed tasks
 *   mean_fix_rounds   mean of the highest fix round reached, over reviewed tasks
 *   questions_rate    `request` messages per task
 *   mean_time_to_result_s  task creation → first finished run, over tasks with one
 */

import { getDb } from './db.js';
import { ensureReviewTable } from './code-review.js';
import { TEMPLATE_KINDS, type TemplateKind } from './rooms.js';

export interface TemplateMetrics {
  template: TemplateKind;
  tasks: number;
  reviewed: number;
  first_pass_rate: number | null;
  mean_fix_rounds: number | null;
  questions_rate: number | null;
  mean_time_to_result_s: number | null;
}

interface TaskRow {
  id: string;
  template: string | null;
  created_at: string;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function roomMetrics(project: string, opts: { since?: string } = {}): TemplateMetrics[] {
  ensureReviewTable();
  const db = getDb();
  const tasks = db.prepare(
    `SELECT id, template, created_at FROM tasks WHERE room = ?${opts.since ? ' AND created_at >= ?' : ''}`,
  ).all(...(opts.since ? [project, opts.since] : [project])) as TaskRow[];

  const reviewsFor = db.prepare(`
    SELECT cr.fix_round AS fix_round, cr.verdict AS verdict
    FROM code_reviews cr JOIN runs r ON r.id = cr.run_id
    WHERE r.task_id = ? AND cr.status = 'done'
  `);
  const questionsFor = db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE ref_task_id = ? AND message_type = 'request'");
  const firstResultFor = db.prepare(`
    SELECT (julianday(MIN(finished_at)) - julianday(?)) * 86400 AS secs
    FROM runs WHERE task_id = ? AND finished_at IS NOT NULL
  `);

  return TEMPLATE_KINDS.map((template) => {
    const mine = tasks.filter((t) => (t.template ?? 'build') === template);
    let reviewed = 0;
    let firstPass = 0;
    let fixRounds = 0;
    let questions = 0;
    let resultSecs = 0;
    let withResult = 0;
    for (const t of mine) {
      const reviews = reviewsFor.all(t.id) as Array<{ fix_round: number; verdict: string | null }>;
      if (reviews.length > 0) {
        reviewed++;
        if (reviews.some((r) => r.fix_round === 0 && r.verdict === 'pass')) firstPass++;
        fixRounds += Math.max(...reviews.map((r) => r.fix_round));
      }
      questions += (questionsFor.get(t.id) as { n: number }).n;
      const secs = (firstResultFor.get(t.created_at, t.id) as { secs: number | null }).secs;
      if (secs !== null && Number.isFinite(secs)) {
        resultSecs += Math.max(0, secs);
        withResult++;
      }
    }
    return {
      template,
      tasks: mine.length,
      reviewed,
      first_pass_rate: reviewed ? round(firstPass / reviewed) : null,
      mean_fix_rounds: reviewed ? round(fixRounds / reviewed) : null,
      questions_rate: mine.length ? round(questions / mine.length) : null,
      mean_time_to_result_s: withResult ? Math.round(resultSecs / withResult) : null,
    };
  });
}
