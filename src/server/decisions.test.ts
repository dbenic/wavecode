/**
 * Tests for decisions CRUD and decision-extractor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('decisions — CRUD', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-decisions-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts and lists decisions by workspace', async () => {
    const { initDb, insertDecision, listDecisions } = await import('./db.js');
    initDb(dbPath);

    insertDecision({
      workspace: '/ws/project-a',
      summary: 'Use RS256 for auth',
      detail: 'Safer than HS256',
    });
    insertDecision({
      workspace: '/ws/project-a',
      summary: 'Store state in SQLite',
    });
    insertDecision({
      workspace: '/ws/project-b',
      summary: 'Use Postgres',
    });

    const projectA = listDecisions('/ws/project-a');
    expect(projectA).toHaveLength(2);
    const summaries = projectA.map(d => d.summary).sort();
    expect(summaries).toEqual(['Store state in SQLite', 'Use RS256 for auth']);

    const projectB = listDecisions('/ws/project-b');
    expect(projectB).toHaveLength(1);
    expect(projectB[0].summary).toBe('Use Postgres');
  });

  it('deletes a decision by ID', async () => {
    const { initDb, insertDecision, listDecisions, deleteDecision } = await import('./db.js');
    initDb(dbPath);

    const result = insertDecision({
      workspace: '/ws/delete-test',
      summary: 'Temp decision',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(listDecisions('/ws/delete-test')).toHaveLength(1);

    const deleted = deleteDecision(result.data.id);
    expect(deleted).toBe(true);

    expect(listDecisions('/ws/delete-test')).toHaveLength(0);
  });

  it('lists all decisions across workspaces', async () => {
    const { initDb, insertDecision, listAllDecisions } = await import('./db.js');
    initDb(dbPath);

    insertDecision({ workspace: '/ws/a', summary: 'Decision A' });
    insertDecision({ workspace: '/ws/b', summary: 'Decision B' });

    const all = listAllDecisions();
    expect(all).toHaveLength(2);
  });

  it('associates decisions with source agent and run', async () => {
    const { initDb, insertAgent, insertDecision, listDecisions } = await import('./db.js');
    initDb(dbPath);

    const agentResult = insertAgent({
      name: 'decider',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace: '/ws/src-test',
      mode: 'spawned',
      status: 'idle',
    });
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;

    insertDecision({
      workspace: '/ws/src-test',
      summary: 'Use barrel exports',
      source_agent_id: agentResult.data.id,
      source_run_id: 'run-123',
    });

    const decisions = listDecisions('/ws/src-test');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].source_agent_id).toBe(agentResult.data.id);
    expect(decisions[0].source_run_id).toBe('run-123');
  });

  it('updateRunChangedFiles persists JSON array on run', async () => {
    const {
      initDb,
      insertAgent,
      insertTask,
      insertRun,
      getRun,
      updateRunChangedFiles,
    } = await import('./db.js');
    initDb(dbPath);

    const agent = insertAgent({
      name: 'runner',
      runtime: 'codex',
      tmux_session: 'test-1',
      workspace: '/ws/cf-test',
      mode: 'spawned',
      status: 'idle',
    });
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;

    const task = insertTask({ prompt: 'test', agent_id: agent.data.id });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    const run = insertRun({ task_id: task.data.id, agent_id: agent.data.id });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    updateRunChangedFiles(run.data.id, ['src/foo.ts', 'src/bar.ts']);

    const updated = getRun(run.data.id);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.data.changed_files).toBe(JSON.stringify(['src/foo.ts', 'src/bar.ts']));
  });

  it('getRecentRunsForWorkspace returns runs with agent and task info', async () => {
    const {
      initDb,
      insertAgent,
      insertTask,
      insertRun,
      finishRun,
      getRecentRunsForWorkspace,
    } = await import('./db.js');
    initDb(dbPath);

    const workspace = '/ws/recent-test';
    const agent = insertAgent({
      name: 'recent-agent',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;

    const task = insertTask({ prompt: 'Build auth', agent_id: agent.data.id });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    const run = insertRun({ task_id: task.data.id, agent_id: agent.data.id });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    finishRun(run.data.id, 0);

    const recent = getRecentRunsForWorkspace(workspace);
    expect(recent).toHaveLength(1);
    expect(recent[0].agent_name).toBe('recent-agent');
    expect(recent[0].task_prompt).toBe('Build auth');
  });

  it('getAgentsByWorkspace returns agents sharing a workspace', async () => {
    const { initDb, insertAgent, getAgentsByWorkspace } = await import('./db.js');
    initDb(dbPath);

    const workspace = '/ws/shared';
    insertAgent({ name: 'a1', runtime: 'claude-code', tmux_session: 't1', workspace, mode: 'spawned', status: 'idle' });
    insertAgent({ name: 'a2', runtime: 'codex', tmux_session: 't2', workspace, mode: 'spawned', status: 'working' });
    insertAgent({ name: 'a3', runtime: 'aider', tmux_session: 't3', workspace: '/ws/other', mode: 'spawned', status: 'idle' });

    const shared = getAgentsByWorkspace(workspace);
    expect(shared).toHaveLength(2);
    expect(shared.map(a => a.name)).toEqual(['a1', 'a2']);
  });
});
