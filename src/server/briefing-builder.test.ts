/**
 * Tests for briefing-builder.ts — context injection for multi-agent dispatch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('briefing-builder.ts', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-briefing-test-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when agent has no workspace', async () => {
    const { initDb, insertAgent } = await import('./db.js');
    initDb(dbPath);

    const agentResult = insertAgent({
      name: 'no-workspace',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace: null,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;

    const { buildBriefing } = await import('./briefing-builder.js');
    const briefing = buildBriefing(agentResult.data, {
      id: 'task-1',
      agent_id: agentResult.data.id,
      prompt: 'Test prompt',
      status: 'pending',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    expect(briefing).toBeNull();
  });

  it('returns null for a solo agent with no decisions or runs', async () => {
    const { initDb, insertAgent } = await import('./db.js');
    initDb(dbPath);

    const agentResult = insertAgent({
      name: 'solo-agent',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace: '/workspace/project',
      mode: 'spawned',
      status: 'idle',
    });
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;

    const { buildBriefing } = await import('./briefing-builder.js');
    const briefing = buildBriefing(agentResult.data, {
      id: 'task-1',
      agent_id: agentResult.data.id,
      prompt: 'Test prompt',
      status: 'pending',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    expect(briefing).toBeNull();
  });

  it('includes sibling agents in the briefing', async () => {
    const { initDb, insertAgent } = await import('./db.js');
    initDb(dbPath);

    const workspace = '/workspace/shared-project';

    const agent1 = insertAgent({
      name: 'agent-alpha',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });

    const agent2 = insertAgent({
      name: 'agent-beta',
      runtime: 'codex',
      tmux_session: 'test-2',
      workspace,
      mode: 'spawned',
      status: 'working',
    });

    expect(agent1.ok && agent2.ok).toBe(true);
    if (!agent1.ok || !agent2.ok) return;

    const { buildBriefing } = await import('./briefing-builder.js');
    const briefing = buildBriefing(agent1.data, {
      id: 'task-1',
      agent_id: agent1.data.id,
      prompt: 'Test prompt',
      status: 'pending',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('agent-beta');
    expect(briefing).toContain('codex');
    expect(briefing).toContain('WORKING');
    expect(briefing).toContain('Sibling Agents');
  });

  it('includes decisions in the briefing', async () => {
    const { initDb, insertAgent, insertDecision } = await import('./db.js');
    initDb(dbPath);

    const workspace = '/workspace/decision-project';

    const agentResult = insertAgent({
      name: 'agent-d',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;

    insertDecision({
      workspace,
      summary: 'Use RS256 for JWT signing',
      detail: 'More secure than HS256',
      source_agent_id: agentResult.data.id,
    });

    insertDecision({
      workspace,
      summary: 'Store sessions in SQLite',
    });

    const { buildBriefing } = await import('./briefing-builder.js');
    const briefing = buildBriefing(agentResult.data, {
      id: 'task-1',
      agent_id: agentResult.data.id,
      prompt: 'Test prompt',
      status: 'pending',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('Use RS256 for JWT signing');
    expect(briefing).toContain('More secure than HS256');
    expect(briefing).toContain('Store sessions in SQLite');
    expect(briefing).toContain('Architectural Decisions');
  });

  it('includes recent runs from sibling agents with changed files', async () => {
    const { initDb, insertAgent, insertTask, insertRun, finishRun, updateRunChangedFiles } = await import('./db.js');
    initDb(dbPath);

    const workspace = '/workspace/runs-project';

    const agent1 = insertAgent({
      name: 'builder',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });

    const agent2 = insertAgent({
      name: 'tester',
      runtime: 'codex',
      tmux_session: 'test-2',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });

    expect(agent1.ok && agent2.ok).toBe(true);
    if (!agent1.ok || !agent2.ok) return;

    // Create a completed task/run for agent2
    const taskResult = insertTask({ prompt: 'Write auth middleware', agent_id: agent2.data.id });
    expect(taskResult.ok).toBe(true);
    if (!taskResult.ok) return;

    const runResult = insertRun({ task_id: taskResult.data.id, agent_id: agent2.data.id });
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;

    finishRun(runResult.data.id, 0);
    updateRunChangedFiles(runResult.data.id, ['src/auth.ts', 'src/middleware.ts']);

    const { buildBriefing } = await import('./briefing-builder.js');
    const briefing = buildBriefing(agent1.data, {
      id: 'task-2',
      agent_id: agent1.data.id,
      prompt: 'Build API routes',
      status: 'pending',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    expect(briefing).not.toBeNull();
    expect(briefing).toContain('src/auth.ts');
    expect(briefing).toContain('tester');
    expect(briefing).toContain('Recent Changes');
  });

  it('truncates briefings exceeding the character budget', async () => {
    const { initDb, insertAgent, insertDecision } = await import('./db.js');
    initDb(dbPath);

    const workspace = '/workspace/long-project';

    const agentResult = insertAgent({
      name: 'agent-long',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;

    // Insert many decisions to exceed the budget
    for (let i = 0; i < 50; i++) {
      insertDecision({
        workspace,
        summary: `Decision ${i}: ${Array(100).fill('x').join('')}`,
        detail: `Detail for decision ${i}: ${Array(200).fill('y').join('')}`,
      });
    }

    const { buildBriefing } = await import('./briefing-builder.js');
    const briefing = buildBriefing(agentResult.data, {
      id: 'task-1',
      agent_id: agentResult.data.id,
      prompt: 'Test',
      status: 'pending',
      priority: 0,
      created_at: new Date().toISOString(),
    });

    expect(briefing).not.toBeNull();
    // Should be truncated to ~3200 chars
    expect(briefing!.length).toBeLessThanOrEqual(3200);
    expect(briefing).toContain('[...truncated]');
  });

  it('previewBriefing returns briefing for a valid agent', async () => {
    const { initDb, insertAgent, insertDecision } = await import('./db.js');
    initDb(dbPath);

    const workspace = '/workspace/preview-project';
    const agentResult = insertAgent({
      name: 'preview-agent',
      runtime: 'claude-code',
      tmux_session: 'test-1',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agentResult.ok).toBe(true);
    if (!agentResult.ok) return;

    insertDecision({ workspace, summary: 'Use TypeScript strict mode' });

    const { previewBriefing } = await import('./briefing-builder.js');
    const preview = previewBriefing(agentResult.data.id, 'Build the feature');

    expect(preview).not.toBeNull();
    expect(preview).toContain('Use TypeScript strict mode');
  });
});
