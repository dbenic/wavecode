/**
 * Tests for the cross-agent review loop: verdict parsing, issue counting,
 * review finalization, the bounded fix loop, and reviewer resolution.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

const reviewConfig = {
  auto_review: true,
  default_reviewer: 'aider',
  self_review: true,
  max_fix_loops: 2,
  require_pass_to_promote: false,
  gate_dependents_on_approval: false,
};

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ review: reviewConfig })),
}));

vi.mock('./session-manager.js', () => ({
  sendKeys: vi.fn(() => ({ ok: true, data: undefined })),
  capturePane: vi.fn(() => ({ ok: true, data: '' })),
}));

vi.mock('./llm-provider.js', () => ({
  completeText: vi.fn(),
}));

vi.mock('./tmux.js', () => ({
  getPaneDir: vi.fn(() => null),
}));

describe('code-review.ts', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    reviewConfig.auto_review = true;
    reviewConfig.max_fix_loops = 2;
    reviewConfig.default_reviewer = 'aider';

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-code-review-'));
    const db = await import('./db.js');
    db.initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedRunFixture() {
    const db = await import('./db.js');

    const author = db.insertAgent({
      name: 'author', runtime: 'codex', tmux_session: 'wc-author',
      workspace: null, mode: 'spawned', status: 'idle',
    });
    const reviewer = db.insertAgent({
      name: 'reviewer', runtime: 'aider', tmux_session: 'wc-reviewer',
      workspace: null, mode: 'spawned', status: 'idle',
    });
    if (!author.ok || !reviewer.ok) throw new Error('seed agents failed');

    const task = db.insertTask({ agent_id: author.data.id, prompt: 'build the thing' });
    if (!task.ok) throw new Error('seed task failed');
    db.updateTaskStatus(task.data.id, 'done');

    const run = db.insertRun({ task_id: task.data.id, agent_id: author.data.id });
    if (!run.ok) throw new Error('seed run failed');
    db.finishRun(run.data.id, 0);

    return { author: author.data, reviewer: reviewer.data, task: task.data, runId: run.data.id };
  }

  function insertReview(db: typeof import('./db.js'), runId: string, fields: {
    status?: string; verdict?: string | null; fixRound?: number; fixesSentAt?: string | null;
  } = {}) {
    const id = db.generateId();
    db.getDb().prepare(`
      INSERT INTO code_reviews (id, run_id, reviewer_type, status, verdict, fix_round, fixes_sent_at)
      VALUES (?, ?, 'cross-model', ?, ?, ?, ?)
    `).run(
      id, runId, fields.status ?? 'done', fields.verdict ?? null,
      fields.fixRound ?? 0, fields.fixesSentAt ?? null,
    );
    return id;
  }

  describe('parseVerdict', () => {
    it('never matches the prompt template line listing all options', async () => {
      const { parseVerdict } = await import('./code-review.js');
      expect(parseVerdict('VERDICT: [PASS / NEEDS FIXES / REJECT]')).toBe('needs-fixes');
    });

    it('takes the last standalone VERDICT line (echoed prompts above are ignored)', async () => {
      const { parseVerdict } = await import('./code-review.js');
      const scraped = [
        'VERDICT: [PASS / NEEDS FIXES / REJECT]',
        'REVIEW SUMMARY: looks solid',
        'VERDICT: PASS',
      ].join('\n');
      expect(parseVerdict(scraped)).toBe('pass');
    });

    it('parses all three verdicts, with or without brackets', async () => {
      const { parseVerdict } = await import('./code-review.js');
      expect(parseVerdict('VERDICT: [PASS]')).toBe('pass');
      expect(parseVerdict('VERDICT: NEEDS FIXES')).toBe('needs-fixes');
      expect(parseVerdict('verdict: reject')).toBe('reject');
    });

    it('falls back to REVIEW PASS marker, and defaults to needs-fixes', async () => {
      const { parseVerdict } = await import('./code-review.js');
      expect(parseVerdict('REVIEW PASS: no issues found.')).toBe('pass');
      expect(parseVerdict('some unstructured rambling')).toBe('needs-fixes');
      // A stray PASS inside prose must NOT count (the old substring bug)
      expect(parseVerdict('This does not PASS my bar, needs work')).toBe('needs-fixes');
    });
  });

  describe('countIssues', () => {
    it('counts both the documented and shorthand severity formats', async () => {
      const { countIssues } = await import('./code-review.js');
      const feedback = [
        'ISSUES:',
        '- [severity: HIGH] SQL injection in query builder',
        '- [MED] missing null check',
        '- [severity: LOW] naming nit',
        '- [low] lowercase severity also counts',
        'not an issue line',
      ].join('\n');
      expect(countIssues(feedback)).toBe(4);
    });
  });

  describe('finalizeReview + fix loop', () => {
    it('stores verdict and issues, emits completion, and sends fixes on needs-fixes', async () => {
      const db = await import('./db.js');
      const events = await import('./event-bus.js');
      const sessionManager = await import('./session-manager.js');
      const codeReview = await import('./code-review.js');

      const { author, runId } = await seedRunFixture();
      const reviewId = insertReview(db, runId, { status: 'reviewing' });

      codeReview.finalizeReview(reviewId, [
        'REVIEW SUMMARY: needs work',
        'ISSUES:',
        '- [severity: HIGH] broken auth check',
        'VERDICT: NEEDS FIXES',
      ].join('\n'));

      const review = codeReview.getReview(reviewId);
      expect(review?.status).toBe('done');
      expect(review?.verdict).toBe('needs-fixes');
      expect(review?.issues_found).toBe(1);
      expect(review?.fixes_sent_at).toBeTruthy();

      // Fixes went back to the author agent
      expect(vi.mocked(sessionManager.sendKeys)).toHaveBeenCalledWith(
        author.id,
        expect.stringContaining('broken auth check'),
      );
      expect(vi.mocked(events.emit)).toHaveBeenCalledWith(
        'review.ai_completed', 'run', runId,
        expect.objectContaining({ verdict: 'needs-fixes', issues_found: 1 }),
      );
      expect(vi.mocked(events.emit)).toHaveBeenCalledWith(
        'review.fixes_sent', 'run', runId,
        expect.objectContaining({ review_id: reviewId }),
      );
    });

    it('does not send fixes on a pass verdict', async () => {
      const db = await import('./db.js');
      const sessionManager = await import('./session-manager.js');
      const codeReview = await import('./code-review.js');

      const { runId } = await seedRunFixture();
      const reviewId = insertReview(db, runId, { status: 'reviewing' });

      codeReview.finalizeReview(reviewId, 'REVIEW SUMMARY: great\nVERDICT: PASS');

      expect(codeReview.getReview(reviewId)?.verdict).toBe('pass');
      expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled();
    });

    it('stops sending fixes once the loop budget is exhausted', async () => {
      const db = await import('./db.js');
      const sessionManager = await import('./session-manager.js');
      const codeReview = await import('./code-review.js');

      const { runId } = await seedRunFixture();
      const reviewId = insertReview(db, runId, { status: 'reviewing', fixRound: 2 });

      codeReview.finalizeReview(reviewId, 'VERDICT: NEEDS FIXES');

      expect(codeReview.getReview(reviewId)?.verdict).toBe('needs-fixes');
      expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled();
    });

    it('does nothing when auto_review is off', async () => {
      const db = await import('./db.js');
      const sessionManager = await import('./session-manager.js');
      const codeReview = await import('./code-review.js');

      reviewConfig.auto_review = false;
      const { runId } = await seedRunFixture();
      const reviewId = insertReview(db, runId, { status: 'reviewing' });

      codeReview.finalizeReview(reviewId, 'VERDICT: NEEDS FIXES');

      expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled();
    });
  });

  describe('resolveReviewerAgentId', () => {
    it('never picks the author, resolving by name then runtime, else null', async () => {
      const codeReview = await import('./code-review.js');
      const { author, reviewer } = await seedRunFixture();

      // default_reviewer 'aider' matches the reviewer agent's runtime
      expect(codeReview.resolveReviewerAgentId(author.id)).toBe(reviewer.id);

      // by exact name
      reviewConfig.default_reviewer = 'reviewer';
      expect(codeReview.resolveReviewerAgentId(author.id)).toBe(reviewer.id);

      // the author itself never reviews its own work
      reviewConfig.default_reviewer = 'author';
      expect(codeReview.resolveReviewerAgentId(author.id)).toBeNull();

      // unknown reviewer → LLM-direct
      reviewConfig.default_reviewer = 'nonexistent';
      expect(codeReview.resolveReviewerAgentId(author.id)).toBeNull();
    });
  });

  describe('maybeAutoReview', () => {
    it('skips when auto_review is off or a review already exists', async () => {
      const db = await import('./db.js');
      const codeReview = await import('./code-review.js');
      const { runId } = await seedRunFixture();

      reviewConfig.auto_review = false;
      await codeReview.maybeAutoReview(runId);
      expect(codeReview.getReviewsForRun(runId)).toHaveLength(0);

      reviewConfig.auto_review = true;
      insertReview(db, runId, { status: 'reviewing' });
      await codeReview.maybeAutoReview(runId);
      expect(codeReview.getReviewsForRun(runId)).toHaveLength(1);
    });
  });

  describe('onAuthorAgentIdle', () => {
    it('is a no-op when no fix round is awaiting re-review', async () => {
      const db = await import('./db.js');
      const codeReview = await import('./code-review.js');
      const { author, runId } = await seedRunFixture();

      // Completed review with no fixes sent → nothing pending
      insertReview(db, runId, { status: 'done', verdict: 'pass' });

      await codeReview.onAuthorAgentIdle(author.id);
      expect(codeReview.getReviewsForRun(runId)).toHaveLength(1);
    });

    it('starts the next review round after fixes were sent', async () => {
      const db = await import('./db.js');
      const codeReview = await import('./code-review.js');
      const tmux = await import('./tmux.js');
      const { author, runId } = await seedRunFixture();

      insertReview(db, runId, {
        status: 'done', verdict: 'needs-fixes', fixRound: 0,
        fixesSentAt: '2026-08-16 10:00:00',
      });

      // Diff capture fails (getPaneDir mocked to null) → the re-review
      // attempt is made but cannot start; verify it TRIED by checking the
      // failure path was hit rather than silently skipping.
      const result = await codeReview.onAuthorAgentIdle(author.id);
      expect(result).toBeUndefined();
      expect(vi.mocked(tmux.getPaneDir)).toHaveBeenCalled();
    });
  });
});
