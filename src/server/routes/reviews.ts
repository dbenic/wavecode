import type { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { getAgent, getRun, getRunArtifacts, resolveAgent } from '../db.js';
import * as reviewQueue from '../review-queue.js';
import * as codeReview from '../code-review.js';
import { presentRunResult } from '../run-result.js';
import { presentFileRun } from '../file-runner.js';
import { getActingUser, resolveRequestToken, type NodeAppEnv } from '../auth.js';
import * as leases from '../leases.js';
import { canMutate, isAdmin } from '../users.js';
import * as freezes from '../release-freezes.js';
import * as devLanes from '../dev-lanes.js';
import * as deployState from '../deploy-state.js';
import { shaStageBlock } from '../sha-stage-block.js';
import { opsStageBlockFromChecks } from '../ops-stage.js';
import logger from '../logger.js';
import * as mergeQueue from '../merge-queue.js';
import { getConfig } from '../config.js';

async function opsStageBlockFor(
  freeze: { sha: string; project: string | null; lane: string | null; gate: string | null; freeze_path?: string | null; verdict: string | null } | null,
  stageBlock: string | null,
): Promise<string | null | undefined> {
  if (!freeze) return undefined;
  try {
    const view = await freezes.viewShaChecks(freeze);
    return opsStageBlockFromChecks({
      sha: freeze.sha,
      quick: view.quick,
      verdict: freeze.verdict,
      stageBlock,
    });
  } catch {
    return 'staging checks are not ready';
  }
}

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

  app.post('/api/ai-reviews/:reviewId/send-fixes', async (c) => {
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

    const result = await codeReview.sendFixesToAgent(review.id);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.get('/api/reviews/lanes', async (c) => {
    try { return c.json(await devLanes.lanesForRequest()); } catch (e) {
      logger.warn({ error: (e as Error).message }, 'Lane list failed');
      return c.json([]);
    }
  });

  app.post('/api/reviews/lanes/request-review', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ project?: string; lane?: string; reviewer?: string }>().catch(() => ({} as { project?: string; lane?: string; reviewer?: string }));
    const result = await devLanes.requestLaneReview({
      project: body.project ?? '', lane: body.lane ?? '', reviewer: body.reviewer ?? null, by: user.name,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.get('/api/reviews/test-log', async (c) => {
    const project = c.req.query('project') ?? '';
    const id = c.req.query('id') ?? '';
    if (!project || !id) return c.json({ error: 'project and id are required' }, 400);
    const result = await devLanes.laneTestLog(project, id);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  // Merge queue (docs/merge-queue.md): read for everyone, the kill switch for admins, priority for developers.
  app.get('/api/merge-queue', (c) => {
    const project = c.req.query('project') ?? null;
    return c.json({
      switches: mergeQueue.configuredProjects().map((name) => mergeQueue.queueSwitch(name)),
      stalls: mergeQueue.configuredProjects().map((name) => mergeQueue.queueStall(name)).filter((s) => s !== null),
      rows: mergeQueue.listQueue(project),
    });
  });

  app.post('/api/merge-queue/:project/switch', async (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Only an admin may flip the merge queue' }, 403);
    const project = c.req.param('project');
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be true or false' }, 400);
    const known = Object.keys(getConfig().projects ?? {}).includes(project);
    if (!known) return c.json({ error: `Unknown project ${project}` }, 404);
    const result = mergeQueue.setQueueSwitch(project, body.enabled, user.name);
    logger.info({ project, enabled: body.enabled, by: user.name }, 'Merge queue switch');
    return c.json(result);
  });

  app.post('/api/merge-queue/:sha/priority', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ priority?: number }>().catch(() => ({} as { priority?: number }));
    if (typeof body.priority !== 'number' || !Number.isFinite(body.priority)) return c.json({ error: 'priority must be a number from 0 to 9' }, 400);
    const row = mergeQueue.setQueuePriority(c.req.param('sha'), body.priority);
    if (!row) return c.json({ error: 'Not in the merge queue' }, 404);
    return c.json(row);
  });

  app.get('/api/reviews/board', async (c) => {
    const user = getActingUser(c);
    const token = resolveRequestToken(c.req.path, c.req.raw.headers, c.req.query('access_token'));
    // The reconciler's snapshot. A request must not scan git or the gate.
    return c.json(await deployState.reviewBoard({ name: user.name, role: user.role }, [], token));
  });

  app.get('/api/reviews', async (c) => {
    const items = reviewQueue.listPendingReviews();
    let lanes: devLanes.DevLane[] = [];
    try { lanes = await devLanes.lanesForRequest(); } catch (e) {
      logger.warn({ error: (e as Error).message }, 'Lane list failed');
    }
    const bySha = new Map(lanes.filter((l) => l.freeze_sha).map((l) => [l.freeze_sha as string, l]));
    const byLane = new Map(lanes.map((l) => [`${l.project}:${l.lane}`, l]));
    return c.json(await Promise.all(items.map(async (item) => {
      const lane = (item.freeze && bySha.get(item.freeze.sha))
        || (item.freeze?.lane ? byLane.get(`${item.freeze.project}:${item.freeze.lane}`) : undefined);
      // The lane row is the current tip. An older SHA, or a lane that is not
      // configured, still gets behind-main and forward-only from its own SHA.
      let stage_block: string | null = null;
      if (item.freeze) {
        try { stage_block = await shaStageBlock(item.freeze); } catch { stage_block = null; }
      }
      if (!stage_block && lane?.freeze_sha && item.freeze?.sha === lane.freeze_sha) stage_block = lane.stage_block;
      const ops_stage_block = await opsStageBlockFor(item.freeze, stage_block);
      if (!lane) return { ...item, stage_block, ops_stage_block };
      return {
        ...item,
        status_line: lane.status_line,
        stage_block,
        ops_stage_block,
        freeze: item.freeze ? { ...item.freeze, gate: lane.gate } : item.freeze,
        promote_block: lane.promote_block,
        full_fail_flag: lane.full_fail_flag,
        test_run: lane.test_run,
        test_errors: lane.test_errors,
        test_log: lane.test_log,
        delta_review: lane.delta_review,
        reviewers: lane.reviewers,
      };
    })));
  });

  app.get('/api/reviews/:runId', async (c) => {
    const result = reviewQueue.getReview(c.req.param('runId'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    let stage_block: string | null = null;
    if (result.data.freeze) {
      try { stage_block = await shaStageBlock(result.data.freeze); } catch { stage_block = null; }
    }
    const ops_stage_block = await opsStageBlockFor(result.data.freeze, stage_block);
    return c.json({ ...result.data, stage_block, ops_stage_block });
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
    const result = await reviewQueue.promote(c.req.param('runId'), {
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
  app.get('/api/reviews/freezes', (c) => c.json(freezes.listReviewFreezes().map(freezes.toCard)));

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
    const result = await freezes.ingestFreezeFile(file);
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
