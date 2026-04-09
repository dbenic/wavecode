import type { Hono } from 'hono';
import { getRunArtifacts } from '../db.js';
import * as reviewQueue from '../review-queue.js';
import * as codeReview from '../code-review.js';
import type { NodeAppEnv } from '../auth.js';

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
    const result = codeReview.sendFixesToAgent(c.req.param('reviewId'));
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

  app.post('/api/reviews/:runId/promote', (c) => {
    const result = reviewQueue.promote(c.req.param('runId'));
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
}
