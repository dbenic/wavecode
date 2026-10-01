import type { Hono } from 'hono';
import fs from 'node:fs';
import { getAgent, getRun, getRunArtifacts } from '../db.js';
import * as reviewQueue from '../review-queue.js';
import * as codeReview from '../code-review.js';
import { presentRunResult } from '../run-result.js';
import { presentFileRun } from '../file-runner.js';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import * as leases from '../leases.js';
import { isAdmin } from '../users.js';

export function registerReviewRoutes(app: Hono<NodeAppEnv>): void {
  app.post('/api/reviews/:runId/ai-review', async (c) => {
    const body = await c.req.json<{
      type?: 'self' | 'cross-model';
      reviewer_agent_id?: string;
      reviewer_runtime?: string;
    }>().catch(() => ({}));

    const runId = c.req.param('runId');
    const reviewType = (body as Record<string, unknown>).type ?? 'cross-model';

    const result = reviewType === 'self'
      ? await codeReview.requestSelfReview(runId)
      : await codeReview.requestCrossModelReview(
        runId,
        (body as Record<string, unknown>).reviewer_agent_id as string | undefined,
        (body as Record<string, unknown>).reviewer_runtime as string | undefined,
      );

    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.get('/api/reviews/:runId/ai-reviews', (c) => {
    return c.json(codeReview.getReviewsForRun(c.req.param('runId')));
  });

  app.post('/api/ai-reviews/:reviewId/send-fixes', (c) => {
    // Sending fixes types a prompt into the run's agent — same ownership
    // rule as a direct send (spec §2 rule 2).
    const review = codeReview.getReview(c.req.param('reviewId'));
    if (!review) return c.json({ error: 'Review not found' }, 404);
    const run = getRun(review.run_id);
    if (!run.ok) return c.json({ error: run.error }, 404);
    const agent = getAgent(run.data.agent_id);
    if (!agent.ok) return c.json({ error: agent.error }, 404);
    const access = leases.checkAgentAccess(agent.data, getActingUser(c));
    if (!access.ok) return c.json({ error: access.error }, 403);

    const result = codeReview.sendFixesToAgent(review.id);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.get('/api/reviews', (c) => {
    return c.json(reviewQueue.listPendingReviews());
  });

  app.get('/api/reviews/:runId', (c) => {
    const result = reviewQueue.getReview(c.req.param('runId'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  app.post('/api/reviews/:runId/promote', async (c) => {
    const body = await c.req.json<{ overrideReason?: string }>().catch(() => ({} as { overrideReason?: string }));
    // Override-promote bypasses the review gate — admin only (spec §2/§3)
    const user = getActingUser(c);
    if (typeof body.overrideReason === 'string' && body.overrideReason.trim() && !isAdmin(user)) {
      return c.json({
        error: `Forbidden: override-promote is admin only (you are ${user.name}, ${user.role}). Promote without override_reason, or ask an admin.`,
      }, 403);
    }
    const result = reviewQueue.promote(c.req.param('runId'), {
      overrideReason: typeof body.overrideReason === 'string' ? body.overrideReason : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.post('/api/reviews/:runId/retry', (c) => {
    const result = reviewQueue.retry(c.req.param('runId'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.post('/api/reviews/:runId/handoff', async (c) => {
    const body = await c.req.json<{ targetAgentId: string }>();
    const target = getAgent(body.targetAgentId);
    if (target.ok) {
      const access = leases.checkAgentAccess(target.data, getActingUser(c));
      if (!access.ok) return c.json({ error: access.error }, 403);
    }
    const result = reviewQueue.handOff(c.req.param('runId'), body.targetAgentId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.post('/api/reviews/:runId/reject', (c) => {
    const result = reviewQueue.reject(c.req.param('runId'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.get('/api/runs/:id/artifacts', (c) => {
    return c.json(getRunArtifacts(c.req.param('id')));
  });

  app.get('/api/runs/:id/result', (c) => {
    const runId = c.req.param('id');
    const result = getRun(runId);
    if (!result.ok) return c.json({ error: result.error }, 404);
    const presented = presentRunResult(result.data.result_path);
    const fileRun = presentFileRun(result.data);
    return c.json({
      run_id: runId,
      path: presented.result_path,
      exists: Boolean(result.data.result_path && fs.existsSync(result.data.result_path)),
      result: presented.result,
      reason: presented.result_reason,
      last_line: presented.result_last_line,
      phase: fileRun.phase,
      log_path: fileRun.log_path,
      prompt_path: fileRun.prompt_path,
    });
  });
}
