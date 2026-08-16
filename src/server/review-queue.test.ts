import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  dispatchNext: vi.fn(),
  unblockDependentsPublic: vi.fn(),
}));

const reviewConfig = {
  auto_review: false,
  default_reviewer: 'aider',
  self_review: true,
  max_fix_loops: 2,
  require_pass_to_promote: false,
  gate_dependents_on_approval: false,
};

const projectsConfig: Record<string, {
  workspace_match: string;
  gate?: { command: string; branch: string; mode?: 'fast' | 'full'; baseline_glob?: string };
  require_result_to_promote?: boolean;
}> = {};

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ review: reviewConfig, projects: projectsConfig })),
}));

describe('review-queue.ts', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    reviewConfig.auto_review = false;
    reviewConfig.require_pass_to_promote = false;
    reviewConfig.gate_dependents_on_approval = false;
    for (const key of Object.keys(projectsConfig)) delete projectsConfig[key];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-review-test-'));
    dbPath = path.join(tmpDir, 'test.db');

    const db = await import('./db.js');
    db.initDb(dbPath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedReviewFixture(workspace: string | null = null) {
    const db = await import('./db.js');

    const sourceAgent = db.insertAgent({
      name: 'source-agent',
      runtime: 'codex',
      tmux_session: 'wc-source-agent',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });

    const targetAgent = db.insertAgent({
      name: 'target-agent',
      runtime: 'aider',
      tmux_session: 'wc-target-agent',
      workspace: null,
      mode: 'spawned',
      status: 'idle',
    });

    if (!sourceAgent.ok || !targetAgent.ok) {
      throw new Error('Failed to seed agents');
    }

    const task = db.insertTask({
      agent_id: sourceAgent.data.id,
      prompt: 'Review this run',
      priority: 1,
    });
    if (!task.ok) {
      throw new Error('Failed to seed task');
    }

    db.updateTaskStatus(task.data.id, 'done');

    const run = db.insertRun({
      task_id: task.data.id,
      agent_id: sourceAgent.data.id,
      attempt: 1,
    });
    if (!run.ok) {
      throw new Error('Failed to seed run');
    }

    db.finishRun(run.data.id, 0);

    return {
      sourceAgentId: sourceAgent.data.id,
      targetAgentId: targetAgent.data.id,
      taskId: task.data.id,
      runId: run.data.id,
    };
  }

  function expectOk<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.data;
  }

  async function insertCompletedAiReview(runId: string, verdict: string) {
    const db = await import('./db.js');
    const id = db.generateId();
    db.getDb().prepare(`
      INSERT INTO code_reviews (id, run_id, reviewer_type, status, verdict)
      VALUES (?, ?, 'cross-model', 'done', ?)
    `).run(id, runId, verdict);
    return id;
  }

  it('blocks promote without a pass verdict when gating is on', async () => {
    const fixture = await seedReviewFixture();
    const queue = await import('./review-queue.js');
    reviewConfig.require_pass_to_promote = true;

    // No review at all → blocked
    const noReview = queue.promote(fixture.runId);
    expect(noReview.ok).toBe(false);
    if (!noReview.ok) expect(noReview.error).toContain('no completed review');

    // Non-pass verdict → blocked
    await insertCompletedAiReview(fixture.runId, 'needs-fixes');
    const nonPass = queue.promote(fixture.runId);
    expect(nonPass.ok).toBe(false);
    if (!nonPass.ok) expect(nonPass.error).toContain("'needs-fixes'");
  });

  it('allows promote with a pass verdict, and auto_review implies gating', async () => {
    const db = await import('./db.js');
    const fixture = await seedReviewFixture();
    const queue = await import('./review-queue.js');
    reviewConfig.auto_review = true; // gating implied, require flag stays off

    await insertCompletedAiReview(fixture.runId, 'pass');
    const result = queue.promote(fixture.runId);
    expect(result.ok).toBe(true);
    expect(expectOk(db.getRun(fixture.runId)).review_status).toBe('approved');
  });

  it('allows a blocked promote through with an explicit override reason, stored in the event', async () => {
    const db = await import('./db.js');
    const events = await import('./event-bus.js');
    const fixture = await seedReviewFixture();
    const queue = await import('./review-queue.js');
    reviewConfig.require_pass_to_promote = true;

    await insertCompletedAiReview(fixture.runId, 'needs-fixes');
    const result = queue.promote(fixture.runId, { overrideReason: 'accepting vs known-red baseline' });

    expect(result.ok).toBe(true);
    expect(expectOk(db.getRun(fixture.runId)).review_status).toBe('approved');
    expect(vi.mocked(events.emit)).toHaveBeenCalledWith(
      'review.promoted', 'run', fixture.runId,
      expect.objectContaining({ override_reason: 'accepting vs known-red baseline' }),
    );
  });

  it('unblocks dependents on promote when approval-gating is on', async () => {
    const fixture = await seedReviewFixture();
    const queue = await import('./review-queue.js');
    const dispatcher = await import('./task-dispatcher.js');
    reviewConfig.gate_dependents_on_approval = true;

    const result = queue.promote(fixture.runId);

    expect(result.ok).toBe(true);
    expect(vi.mocked(dispatcher.unblockDependentsPublic)).toHaveBeenCalledWith(fixture.taskId);
  });

  it('promotes a pending review inside a transaction', async () => {
    const db = await import('./db.js');
    const fixture = await seedReviewFixture();
    const transactionSpy = vi.spyOn(db.getDb(), 'transaction');
    const queue = await import('./review-queue.js');

    const result = queue.promote(fixture.runId);

    expect(result.ok).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(expectOk(db.getRun(fixture.runId)).review_status).toBe('approved');
  });

  it('retries a review atomically and re-dispatches the task', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');
    const fixture = await seedReviewFixture();
    const transactionSpy = vi.spyOn(db.getDb(), 'transaction');
    const queue = await import('./review-queue.js');

    const result = queue.retry(fixture.runId);
    vi.runAllTimers();

    expect(result.ok).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(expectOk(db.getRun(fixture.runId)).review_status).toBe('rejected');
    expect(expectOk(db.getTask(fixture.taskId)).status).toBe('pending');
    expect(dispatcher.dispatchNext).toHaveBeenCalled();
  });

  it('hands off a review atomically to another agent', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');
    const fixture = await seedReviewFixture();
    const transactionSpy = vi.spyOn(db.getDb(), 'transaction');
    const queue = await import('./review-queue.js');

    const result = queue.handOff(fixture.runId, fixture.targetAgentId);
    vi.runAllTimers();

    expect(result.ok).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(expectOk(db.getRun(fixture.runId)).review_status).toBe('rejected');
    expect(expectOk(db.getTask(fixture.taskId)).agent_id).toBe(fixture.targetAgentId);
    expect(expectOk(db.getTask(fixture.taskId)).status).toBe('pending');
    expect(dispatcher.dispatchNext).toHaveBeenCalled();
  });

  it('blocks promote on a gated project when no referee RESULT is stored', async () => {
    const fixture = await seedReviewFixture('/srv/apps/wavepulse');
    const queue = await import('./review-queue.js');
    projectsConfig.wavepulse = {
      workspace_match: '**/wavepulse*',
      gate: { command: 'wavepulse-gate', branch: 'landing-v3-human-first', mode: 'full' },
      require_result_to_promote: true,
    };

    const blocked = queue.promote(fixture.runId, { overrideReason: 'known-red' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain('no referee RESULT');
  });

  it('allows promote on a gated project after a GREEN RESULT (AI review can still gate)', async () => {
    const db = await import('./db.js');
    const gate = await import('./project-gate.js');
    const fixture = await seedReviewFixture('/srv/apps/wavepulse');
    const queue = await import('./review-queue.js');
    projectsConfig.wavepulse = {
      workspace_match: '**/wavepulse*',
      gate: { command: 'wavepulse-gate', branch: 'landing-v3-human-first', mode: 'full' },
      require_result_to_promote: true,
    };
    gate.storeGateResult(fixture.runId, {
      result_line: 'RESULT GREEN branch=landing-v3-human-first sha=abc12345 lint=PASS unit=PASS frontend=PASS',
      log_path: null,
      exit_code: 0,
      mode: 'full',
      branch: 'landing-v3-human-first',
      sha: 'abc12345',
      checked_at: '2026-08-16T00:00:00Z',
    });

    const result = queue.promote(fixture.runId);
    expect(result.ok).toBe(true);
    expect(expectOk(db.getRun(fixture.runId)).review_status).toBe('approved');
  });

  it('rejects a review atomically and fails the task', async () => {
    const db = await import('./db.js');
    const fixture = await seedReviewFixture();
    const transactionSpy = vi.spyOn(db.getDb(), 'transaction');
    const queue = await import('./review-queue.js');

    const result = queue.reject(fixture.runId);

    expect(result.ok).toBe(true);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(expectOk(db.getRun(fixture.runId)).review_status).toBe('rejected');
    expect(expectOk(db.getTask(fixture.taskId)).status).toBe('failed');
  });
});
