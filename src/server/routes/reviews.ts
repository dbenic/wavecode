import type { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { getAgent, getRun, getRunArtifacts, resolveAgent } from '../db.js';
import * as reviewQueue from '../review-queue.js';
import * as codeReview from '../code-review.js';
import { presentRunResult } from '../run-result.js';
import { presentFileRun } from '../file-runner.js';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import * as leases from '../leases.js';
import { canMutate, isAdmin } from '../users.js';
import * as freezes from '../release-freezes.js';

export function registerReviewRoutes(app: Hono<NodeAppEnv>): void {
  app.post('/api/reviews/:runId/ai-review', async (c) => {
    const body = await c.req.json<{
      type?: 'self' | 'cross-model';
      reviewer_agent_id?: string;
      reviewer_runtime?: string;
    }>().catch(() => ({} as Record<string, unknown>));

    const runId = c.req.param('runId');
    const reviewType = (body as Record<string, unknown>).type ?? 'cross-model';
    if (reviewType === 'self') {
      const result = await codeReview.requestSelfReview(runId);
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json(result.data);
    }

    const reviewerRef = (body as Record<string, unknown>).reviewer_agent_id;
    const reviewerRuntime = (body as Record<string, unknown>).reviewer_runtime;
    // Ladder rung 1 (explicit, alias → name → id) or, with nothing named, the
    // ladder itself. A reviewer_runtime without an agent keeps the LLM-direct path.
    if (typeof reviewerRef === 'string' || typeof reviewerRuntime !== 'string') {
      const run = getRun(runId);
      if (!run.ok) return c.json({ error: run.error }, 404);
      const result = await codeReview.startReviewByLadder(run.data, 0, typeof reviewerRef === 'string' ? reviewerRef : null);
      if (!result.ok) return c.json({ error: result.error }, typeof reviewerRef === 'string' ? 400 : 409);
      return c.json(result.data);
    }
    const result = await codeReview.requestCrossModelReview(runId, undefined, reviewerRuntime);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.post('/api/ai-reviews/:reviewId/reassign', async (c) => {
    // Hand a running or waiting review to another agent (thread "Change" chip, `#review #n @agent`).
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: `Forbidden: observers cannot reassign reviews` }, 403);
    const body = await c.req.json<{ reviewer?: string }>().catch(() => ({} as { reviewer?: string }));
    if (typeof body.reviewer !== 'string' || !body.reviewer.trim()) return c.json({ error: 'reviewer is required (@alias, name or id)' }, 400);
    const result = await codeReview.reassignReview(c.req.param('reviewId'), body.reviewer.trim(), user.name);
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
    const target = resolveAgent(String(body.targetAgentId ?? ''));
    if (target.ok) {
      const access = leases.checkAgentAccess(target.data, getActingUser(c));
      if (!access.ok) return c.json({ error: access.error }, 403);
    }
    const result = reviewQueue.handOff(c.req.param('runId'), target.ok ? target.data.id : body.targetAgentId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.post('/api/reviews/:runId/reject', async (c) => {
    const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    const result = reviewQueue.reject(c.req.param('runId'), { reason: typeof body.reason === 'string' ? body.reason : null });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  // Release freezes reviewed by files (release-freezes.ts). The watcher ingests
  // the freeze inbox on its own; a reviewer may also hand a file in directly.
  app.get('/api/reviews/freezes', (c) => c.json(freezes.listFreezes().map(freezes.toCard)));

  app.post('/api/reviews/freezes/ingest', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ path?: string }>().catch(() => ({} as { path?: string }));
    const file = typeof body.path === 'string' ? body.path.trim() : '';
    const dirs = freezes.freezeInboxDirs();
    const inside = dirs.some((d) => pathInside(file, d));
    if (!file || !inside) {
      return c.json({ error: `path must be a file inside the freeze inbox (${dirs.join(', ') || 'review.freeze_inbox is not configured'})` }, 400);
    }
    const result = freezes.ingestFreezeFile(file);
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

function pathInside(file: string, dir: string): boolean {
  if (!path.isAbsolute(file) || file.includes('..')) return false;
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}
