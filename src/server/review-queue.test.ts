import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  dispatchNext: vi.fn(),
}));

describe('review-queue.ts', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
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

  async function seedReviewFixture() {
    const db = await import('./db.js');

    const sourceAgent = db.insertAgent({
      name: 'source-agent',
      runtime: 'codex',
      tmux_session: 'wc-source-agent',
      workspace: null,
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
