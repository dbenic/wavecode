/**
 * Goals persist as first-class rows; child tasks roll up; unattached tasks still work.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';

describe('goals persist + rollup', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-goals-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists a goal and lists child tasks with rollup counts', async () => {
    const db = await import('./db.js');
    db.initDb(dbPath);

    const goal = db.insertGoal({
      title: 'Employee incoming view',
      workspace: '/ws/countix',
      external_id: 'F-16',
    });
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;

    const childA = db.insertTask({ prompt: 'Add /incoming route', priority: 8, goal_id: goal.data.id });
    const childB = db.insertTask({ prompt: 'Strip fields by role', priority: 6, goal_id: goal.data.id });
    const childC = db.insertTask({ prompt: 'Write tests', priority: 4, goal_id: goal.data.id });
    expect(childA.ok && childB.ok && childC.ok).toBe(true);
    if (!childA.ok || !childB.ok || !childC.ok) return;

    db.updateTaskStatus(childA.data.id, 'done');
    db.updateTaskStatus(childB.data.id, 'running');

    const listed = db.listGoalsWithRollup();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(goal.data.id);
    expect(listed[0].external_id).toBe('F-16');
    expect(listed[0].rollup).toEqual({
      pending: 1,
      running: 1,
      done: 1,
      failed: 0,
      blocked: 0,
      total: 3,
    });

    const children = db.listTasks({ goal_id: goal.data.id });
    expect(children).toHaveLength(3);
    expect(children.every((t) => t.goal_id === goal.data.id)).toBe(true);

    const byExternal = db.getGoalWithRollup('F-16');
    expect(byExternal.ok).toBe(true);
    if (byExternal.ok) {
      expect(byExternal.data.id).toBe(goal.data.id);
      expect(byExternal.data.rollup.done).toBe(1);
    }
  });

  it('lets tasks exist without a goal', async () => {
    const db = await import('./db.js');
    db.initDb(dbPath);

    const orphan = db.insertTask({ prompt: 'Standalone hotfix', priority: 9 });
    expect(orphan.ok).toBe(true);
    if (!orphan.ok) return;
    expect(orphan.data.goal_id).toBeNull();

    const goal = db.insertGoal({ title: 'Unrelated epic' });
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;
    db.insertTask({ prompt: 'Epic child', goal_id: goal.data.id });

    const all = db.listTasks();
    expect(all).toHaveLength(2);
    expect(all.filter((t) => t.goal_id === null)).toHaveLength(1);
    expect(db.listTasks({ goal_id: goal.data.id })).toHaveLength(1);
    expect(db.listGoalsWithRollup()[0].rollup.total).toBe(1);
  });

  it('GET /api/goals and GET /api/goals/:id return persisted children + rollup', async () => {
    const db = await import('./db.js');
    db.initDb(dbPath);

    const goal = db.insertGoal({ title: 'Ship auth', external_id: 'G1' });
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;
    db.insertTask({ prompt: 'Design schema', goal_id: goal.data.id });
    const running = db.insertTask({ prompt: 'Implement API', goal_id: goal.data.id });
    expect(running.ok).toBe(true);
    if (running.ok) db.updateTaskStatus(running.data.id, 'done');

    const { registerGoalRoutes } = await import('./routes/goals.js');
    const app = new Hono();
    registerGoalRoutes(app);

    const listRes = await app.fetch(new Request('http://localhost/api/goals'));
    expect(listRes.status).toBe(200);
    const listed = await listRes.json() as Array<{ id: string; rollup: { done: number; total: number } }>;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(goal.data.id);
    expect(listed[0].rollup).toMatchObject({ done: 1, total: 2 });

    const oneRes = await app.fetch(new Request('http://localhost/api/goals/G1'));
    expect(oneRes.status).toBe(200);
    const one = await oneRes.json() as {
      id: string;
      external_id: string;
      tasks: Array<{ prompt: string; goal_id: string }>;
      rollup: { done: number; pending: number; total: number };
    };
    expect(one.id).toBe(goal.data.id);
    expect(one.external_id).toBe('G1');
    expect(one.tasks).toHaveLength(2);
    expect(one.tasks.every((t) => t.goal_id === goal.data.id)).toBe(true);
    expect(one.rollup).toMatchObject({ done: 1, pending: 1, total: 2 });
  });
});
