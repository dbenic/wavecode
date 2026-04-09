import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const CODEX_IDLE_OUTPUT = [
  'gpt-5.4 xhigh · 47% left · ~/project',
  '›',
].join('\n');

const CODEX_WORKING_OUTPUT = [
  '◦ Working (12s • esc to interrupt)',
  'gpt-5.4 xhigh · 47% left · ~/project',
].join('\n');

const tmuxHarness = vi.hoisted(() => {
  interface SessionState {
    name: string;
    workDir: string;
    output: string;
    sentTexts: string[];
    rawKeys: string[];
    created: number;
    lastActivity: number;
  }

  const sessions = new Map<string, SessionState>();
  let clock = 1_700_000_000;
  const codexIdleOutput = [
    'gpt-5.4 xhigh · 47% left · ~/project',
    '›',
  ].join('\n');

  function nextTimestamp(): number {
    clock += 1;
    return clock;
  }

  function idleOutputForCommand(command?: string): string {
    if (!command) return '$ ';
    if (command.includes('codex')) return `${codexIdleOutput}\n`;
    if (command.includes('claude')) return 'Brewed for 1s\n⏵⏵ claude-code (shift+tab to cycle)\n';
    return '$ ';
  }

  return {
    reset() {
      sessions.clear();
      clock = 1_700_000_000;
    },
    createSession(name: string, workDir: string, output = codexIdleOutput) {
      const created = nextTimestamp();
      sessions.set(name, {
        name,
        workDir,
        output,
        sentTexts: [],
        rawKeys: [],
        created,
        lastActivity: created,
      });
    },
    newSession(name: string, workDir: string, command?: string) {
      this.createSession(name, workDir, idleOutputForCommand(command));
      if (command) {
        const session = sessions.get(name);
        if (session) {
          session.sentTexts.push(command);
        }
      }
    },
    setOutput(name: string, output: string) {
      const session = sessions.get(name);
      if (!session) throw new Error(`Unknown fake tmux session: ${name}`);
      session.output = output;
      session.lastActivity = nextTimestamp();
    },
    hasSession(name: string): boolean {
      return sessions.has(name);
    },
    killSession(name: string) {
      sessions.delete(name);
    },
    listSessions() {
      return Array.from(sessions.values()).map((session) => ({
        name: session.name,
        created: session.created,
        lastActivity: session.lastActivity,
      }));
    },
    sendTextAndEnter(name: string, text: string) {
      const session = sessions.get(name);
      if (!session) throw new Error(`Unknown fake tmux session: ${name}`);
      session.sentTexts.push(text);
      session.lastActivity = nextTimestamp();
    },
    sendRawKey(name: string, key: string) {
      const session = sessions.get(name);
      if (!session) throw new Error(`Unknown fake tmux session: ${name}`);
      session.rawKeys.push(key);
      session.lastActivity = nextTimestamp();
    },
    getSentTexts(name: string): string[] {
      return [...(sessions.get(name)?.sentTexts ?? [])];
    },
    capturePane(name: string): string {
      const session = sessions.get(name);
      if (!session) throw new Error(`Unknown fake tmux session: ${name}`);
      return session.output;
    },
    getScrollbackSize(name: string): number {
      return this.capturePane(name).split('\n').length;
    },
    getPaneDir(name: string): string | null {
      return sessions.get(name)?.workDir ?? null;
    },
    isAllowedRawKey(key: string): boolean {
      return ['Enter', 'Escape', 'C-c', 'y', 'n'].includes(key);
    },
    isValidSessionName(name: string): boolean {
      return /^[a-zA-Z0-9._-]+$/.test(name);
    },
  };
});

const runnerMocks = vi.hoisted(() => ({
  startRunner: vi.fn(),
  stopRunner: vi.fn(),
  executeRun: vi.fn(async () => null),
  getRunner: vi.fn(),
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn((name: string) => tmuxHarness.hasSession(name)),
  listSessions: vi.fn(() => ({ ok: true, data: tmuxHarness.listSessions() })),
  newSession: vi.fn((name: string, workDir: string, command?: string) => {
    tmuxHarness.newSession(name, workDir, command);
  }),
  killSession: vi.fn((name: string) => {
    tmuxHarness.killSession(name);
  }),
  sendTextAndEnter: vi.fn((name: string, text: string) => {
    tmuxHarness.sendTextAndEnter(name, text);
  }),
  sendRawKey: vi.fn((name: string, key: string) => {
    tmuxHarness.sendRawKey(name, key);
  }),
  capturePane: vi.fn((name: string) => ({ ok: true, data: tmuxHarness.capturePane(name) })),
  capturePaneAnsi: vi.fn((name: string) => ({ ok: true, data: tmuxHarness.capturePane(name) })),
  capturePaneRange: vi.fn((name: string) => ({ ok: true, data: tmuxHarness.capturePane(name) })),
  getScrollbackSize: vi.fn((name: string) => ({ ok: true, data: tmuxHarness.getScrollbackSize(name) })),
  getPaneDir: vi.fn((name: string) => tmuxHarness.getPaneDir(name)),
  isAllowedRawKey: vi.fn((key: string) => tmuxHarness.isAllowedRawKey(key)),
  isValidSessionName: vi.fn((name: string) => tmuxHarness.isValidSessionName(name)),
}));

vi.mock('./runner.js', () => runnerMocks);

vi.mock('./briefing-builder.js', () => ({
  buildBriefing: vi.fn(() => null),
}));

vi.mock('./decision-extractor.js', () => ({
  extractDecisions: vi.fn(async () => []),
}));

vi.mock('./task-verifier.js', () => ({
  verifyTaskCompletion: vi.fn(async () => null),
}));

const notificationsMocks = vi.hoisted(() => ({
  notifyAgentCrashed: vi.fn(async () => null),
}));

vi.mock('./notifications.js', () => notificationsMocks);

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const tempDirs: string[] = [];

describe('agent runtime integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tmuxHarness.reset();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      const outputWatcher = await import('./output-watcher.js');
      outputWatcher.stopAll();
    } catch {
      // Module may not have been imported in this test.
    }

    try {
      const healthMonitor = await import('./health-monitor.js');
      healthMonitor.stopHealthMonitor();
    } catch {
      // Module may not have been imported in this test.
    }

    try {
      const db = await import('./db.js');
      db.resetDbForTest();
    } catch {
      // Module may not have been imported in this test.
    }

    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    vi.useRealTimers();
    vi.resetModules();
  });

  it('recreates a spawned session after a crash without losing workspace state', async () => {
    const { tempDir } = await setupEnvironment();
    const workspace = path.join(tempDir, 'projects', 'builder');

    const app = await createTestApp();
    const sessionManager = await import('./session-manager.js');

    const spawned = await postJson(app, '/api/agents/spawn', {
      name: 'builder',
      runtime: 'codex',
    });

    expect(spawned.status).toBe(201);
    const spawnedAgent = spawned.json as {
      id: string;
      workspace: string | null;
    };

    expect(tmuxHarness.hasSession('wc-builder')).toBe(true);
    expect(runnerMocks.startRunner).toHaveBeenCalledWith(
      spawnedAgent.id,
      'wc-builder',
      'codex',
    );

    tmuxHarness.killSession('wc-builder');
    expect(tmuxHarness.hasSession('wc-builder')).toBe(false);

    const recovered = sessionManager.ensureSpawnedAgentSession(spawnedAgent.id);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;

    expect(recovered.data.createdSession).toBe(true);
    expect(recovered.data.agent.workspace).toBe(spawnedAgent.workspace);
    expect(tmuxHarness.hasSession('wc-builder')).toBe(true);

    const secondCheck = sessionManager.ensureSpawnedAgentSession(spawnedAgent.id);
    expect(secondCheck.ok).toBe(true);
    if (!secondCheck.ok) return;
    expect(secondCheck.data.createdSession).toBe(false);
  });

  it('unblocks dependent work and delivers a result message between adopted agents', async () => {
    await setupEnvironment();
    tmuxHarness.createSession('alpha-session', '/tmp/alpha', CODEX_IDLE_OUTPUT);
    tmuxHarness.createSession('beta-session', '/tmp/beta', CODEX_IDLE_OUTPUT);

    const app = await createTestApp();
    const taskDispatcher = await import('./task-dispatcher.js');
    const db = await import('./db.js');

    const agentA = await adoptAgent(app, 'alpha-session', 'codex', 'alpha');
    const agentB = await adoptAgent(app, 'beta-session', 'codex', 'beta');

    const taskA = await createTask(app, {
      prompt: 'Build the shared auth middleware',
      agent_id: agentA.id,
    });
    const taskB = await createTask(app, {
      prompt: 'Wire the dashboard to the auth middleware',
      agent_id: agentB.id,
      depends_on: [taskA.id],
    });

    await taskDispatcher.dispatchNext({ manual: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(tmuxHarness.getSentTexts('alpha-session')).toContain('Build the shared auth middleware');
    expect(tmuxHarness.getSentTexts('beta-session')).not.toContain('Wire the dashboard to the auth middleware');

    await completeAdoptedRun('alpha-session');

    const completedTaskA = db.getTask(taskA.id);
    expect(completedTaskA.ok).toBe(true);
    if (completedTaskA.ok) {
      expect(completedTaskA.data.status).toBe('done');
    }

    const messages = db.listAgentMessages({ to_agent_id: agentB.id }) as Array<{
      from_agent_id: string | null;
      to_agent_id: string | null;
      message_type: string;
      message: string;
    }>;

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_agent_id: agentA.id,
        to_agent_id: agentB.id,
        message_type: 'result',
      }),
    ]));
    expect(messages[0]?.message).toContain('completed successfully');

    await taskDispatcher.dispatchNext({ manual: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(tmuxHarness.getSentTexts('beta-session')).toContain('Wire the dashboard to the auth middleware');

    await completeAdoptedRun('beta-session');

    const completedTaskB = db.getTask(taskB.id);
    expect(completedTaskB.ok).toBe(true);
    if (completedTaskB.ok) {
      expect(completedTaskB.data.status).toBe('done');
    }
  });

  it('reconciles interrupted spawned work on startup without duplicating the agent record', async () => {
    await setupEnvironment();

    const app = await createTestApp();
    const db = await import('./db.js');
    const outputWatcher = await import('./output-watcher.js');
    const startupReconcile = await import('./startup-reconcile.js');

    const spawned = await postJson(app, '/api/agents/spawn', {
      name: 'builder',
      runtime: 'codex',
    });

    expect(spawned.status).toBe(201);
    const agent = spawned.json as { id: string; workspace: string | null };
    expect(agent.workspace).toContain('/projects/builder');

    const task = db.insertTask({
      agent_id: agent.id,
      prompt: 'Recover the interrupted build session',
    });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    db.updateTaskStatus(task.data.id, 'running');

    const run = db.insertRun({
      task_id: task.data.id,
      agent_id: agent.id,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    db.updateAgentStatus(agent.id, 'working');
    outputWatcher.stopAll();
    tmuxHarness.killSession('wc-builder');

    const result = await startupReconcile.reconcileStartupState();

    const recoveredAgent = db.getAgent(agent.id);
    const recoveredTask = db.getTask(task.data.id);
    const recoveredRun = db.getRun(run.data.id);
    const events = db.listEvents().map((event) => event.type);

    expect(result.sessionsRecreated).toBe(1);
    expect(result.runsRecovered).toBe(1);
    expect(result.tasksRequeued).toBe(1);
    expect(db.listAgents()).toHaveLength(1);
    expect(tmuxHarness.hasSession('wc-builder')).toBe(true);
    expect(outputWatcher.isWatching(agent.id)).toBe(true);
    expect(runnerMocks.startRunner).toHaveBeenCalledTimes(2);
    expect(events).toContain('run.failed');
    expect(events).toContain('task.retrying');

    expect(recoveredAgent.ok).toBe(true);
    if (recoveredAgent.ok) {
      expect(recoveredAgent.data.id).toBe(agent.id);
      expect(recoveredAgent.data.status).toBe('idle');
      expect(recoveredAgent.data.workspace).toBe(agent.workspace);
    }

    expect(recoveredTask.ok).toBe(true);
    if (recoveredTask.ok) {
      expect(recoveredTask.data.status).toBe('pending');
    }

    expect(recoveredRun.ok).toBe(true);
    if (recoveredRun.ok) {
      expect(recoveredRun.data.status).toBe('failed');
      expect(recoveredRun.data.exit_code).toBe(1);
    }
  });

  it('fails adopted in-flight work when the tmux session is gone on startup', async () => {
    await setupEnvironment();

    const db = await import('./db.js');
    const startupReconcile = await import('./startup-reconcile.js');

    tmuxHarness.createSession('legacy-shell', '/tmp/legacy-shell', CODEX_IDLE_OUTPUT);

    const agent = db.insertAgent({
      name: 'legacy-shell',
      runtime: 'codex',
      tmux_session: 'legacy-shell',
      workspace: null,
      mode: 'adopted',
      status: 'working',
    });
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;

    const task = db.insertTask({
      agent_id: agent.data.id,
      prompt: 'Finish the legacy review',
    });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    db.updateTaskStatus(task.data.id, 'running');

    const run = db.insertRun({
      task_id: task.data.id,
      agent_id: agent.data.id,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    tmuxHarness.killSession('legacy-shell');

    const result = await startupReconcile.reconcileStartupState();

    const recoveredAgent = db.getAgent(agent.data.id);
    const recoveredTask = db.getTask(task.data.id);
    const recoveredRun = db.getRun(run.data.id);
    const events = db.listEvents().map((event) => event.type);

    expect(result.adoptedMissingSessions).toBe(1);
    expect(result.runsRecovered).toBe(1);
    expect(result.tasksFailed).toBe(1);
    expect(events).toContain('task.failed');
    expect(events).toContain('agent.crashed');

    expect(recoveredAgent.ok).toBe(true);
    if (recoveredAgent.ok) {
      expect(recoveredAgent.data.status).toBe('error');
    }

    expect(recoveredTask.ok).toBe(true);
    if (recoveredTask.ok) {
      expect(recoveredTask.data.status).toBe('failed');
    }

    expect(recoveredRun.ok).toBe(true);
    if (recoveredRun.ok) {
      expect(recoveredRun.data.status).toBe('failed');
      expect(recoveredRun.data.exit_code).toBe(1);
    }
  });

  it('backfills workspace and requeues orphan running tasks when sessions survive restart', async () => {
    await setupEnvironment();

    const db = await import('./db.js');
    const outputWatcher = await import('./output-watcher.js');
    const startupReconcile = await import('./startup-reconcile.js');

    tmuxHarness.createSession('wc-reviewer', '/tmp/reviewer-project', CODEX_IDLE_OUTPUT);

    const agent = db.insertAgent({
      name: 'reviewer',
      runtime: 'codex',
      tmux_session: 'wc-reviewer',
      workspace: null,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;

    const task = db.insertTask({
      agent_id: agent.data.id,
      prompt: 'Resume the orphaned review task',
    });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    db.updateTaskStatus(task.data.id, 'running');
    outputWatcher.stopAll();

    const result = await startupReconcile.reconcileStartupState();

    const recoveredAgent = db.getAgent(agent.data.id);
    const recoveredTask = db.getTask(task.data.id);
    const events = db.listEvents().map((event) => event.type);

    expect(result.sessionsRecreated).toBe(0);
    expect(result.orphanRunningTasksRequeued).toBe(1);
    expect(events).toContain('task.retrying');
    expect(outputWatcher.isWatching(agent.data.id)).toBe(true);

    expect(recoveredAgent.ok).toBe(true);
    if (recoveredAgent.ok) {
      expect(recoveredAgent.data.workspace).toBe('/tmp/reviewer-project');
    }

    expect(recoveredTask.ok).toBe(true);
    if (recoveredTask.ok) {
      expect(recoveredTask.data.status).toBe('pending');
    }
  });

  it('restarts crashed spawned agents, emits recovery events, and redispatches work', async () => {
    await setupEnvironment({ autoDispatch: true });

    const app = await createTestApp();
    const db = await import('./db.js');
    const healthMonitor = await import('./health-monitor.js');

    runnerMocks.executeRun.mockResolvedValue({ id: 'restarted-run' });

    const spawned = await postJson(app, '/api/agents/spawn', {
      name: 'builder',
      runtime: 'codex',
    });

    expect(spawned.status).toBe(201);
    const agent = spawned.json as { id: string };

    const task = db.insertTask({
      agent_id: agent.id,
      prompt: 'Continue the interrupted build',
    });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    db.updateTaskStatus(task.data.id, 'running');

    const run = db.insertRun({
      task_id: task.data.id,
      agent_id: agent.id,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    db.updateAgentStatus(agent.id, 'working');
    tmuxHarness.killSession('wc-builder');

    healthMonitor.startHealthMonitor();
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(1000);

    const recoveredAgent = db.getAgent(agent.id);
    const recoveredTask = db.getTask(task.data.id);
    const recoveredRun = db.getRun(run.data.id);
    const events = db.listEvents().map((event) => event.type);

    expect(tmuxHarness.hasSession('wc-builder')).toBe(true);
    expect(runnerMocks.executeRun).toHaveBeenCalledWith(
      agent.id,
      task.data.id,
      'Continue the interrupted build',
    );
    expect(notificationsMocks.notifyAgentCrashed).toHaveBeenCalledWith('builder', agent.id);

    expect(events).toEqual(expect.arrayContaining([
      'agent.crashed',
      'run.failed',
      'task.retrying',
      'agent.restarted',
      'task.dispatched',
    ]));
    expect(events.indexOf('agent.crashed')).toBeLessThan(events.indexOf('agent.restarted'));
    expect(events.indexOf('run.failed')).toBeLessThan(events.indexOf('task.retrying'));

    expect(recoveredAgent.ok).toBe(true);
    if (recoveredAgent.ok) {
      expect(recoveredAgent.data.status).toBe('working');
    }

    expect(recoveredTask.ok).toBe(true);
    if (recoveredTask.ok) {
      expect(recoveredTask.data.status).toBe('running');
    }

    expect(recoveredRun.ok).toBe(true);
    if (recoveredRun.ok) {
      expect(recoveredRun.data.status).toBe('failed');
      expect(recoveredRun.data.exit_code).toBe(1);
    }
  });

  it('recovers hung spawned agents across health-monitor cycles', async () => {
    await setupEnvironment({ autoDispatch: false, hangTimeoutMin: 0 });

    const app = await createTestApp();
    const db = await import('./db.js');
    const healthMonitor = await import('./health-monitor.js');
    const outputWatcher = await import('./output-watcher.js');

    const spawned = await postJson(app, '/api/agents/spawn', {
      name: 'reviewer',
      runtime: 'codex',
    });

    expect(spawned.status).toBe(201);
    const agent = spawned.json as { id: string };

    const task = db.insertTask({
      agent_id: agent.id,
      prompt: 'Finish the hung review task',
    });
    expect(task.ok).toBe(true);
    if (!task.ok) return;

    db.updateTaskStatus(task.data.id, 'running');

    const run = db.insertRun({
      task_id: task.data.id,
      agent_id: agent.id,
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    db.updateAgentStatus(agent.id, 'working');
    outputWatcher.stopAll();

    healthMonitor.startHealthMonitor();
    await vi.advanceTimersByTimeAsync(30000);
    expect(tmuxHarness.hasSession('wc-reviewer')).toBe(true);

    await vi.advanceTimersByTimeAsync(30000);
    expect(tmuxHarness.hasSession('wc-reviewer')).toBe(false);

    await vi.advanceTimersByTimeAsync(30000);

    const recoveredAgent = db.getAgent(agent.id);
    const recoveredTask = db.getTask(task.data.id);
    const recoveredRun = db.getRun(run.data.id);
    const events = db.listEvents().map((event) => event.type);

    expect(tmuxHarness.hasSession('wc-reviewer')).toBe(true);
    expect(notificationsMocks.notifyAgentCrashed).toHaveBeenCalledWith('reviewer', agent.id);
    expect(events).toEqual(expect.arrayContaining([
      'agent.crashed',
      'run.failed',
      'task.retrying',
      'agent.restarted',
    ]));

    expect(recoveredAgent.ok).toBe(true);
    if (recoveredAgent.ok) {
      expect(recoveredAgent.data.status).toBe('idle');
    }

    expect(recoveredTask.ok).toBe(true);
    if (recoveredTask.ok) {
      expect(recoveredTask.data.status).toBe('pending');
    }

    expect(recoveredRun.ok).toBe(true);
    if (recoveredRun.ok) {
      expect(recoveredRun.data.status).toBe('failed');
      expect(recoveredRun.data.exit_code).toBe(1);
    }
  });

  it('streams and replays task and message events through the event bus', async () => {
    await setupEnvironment();
    tmuxHarness.createSession('alpha-session', '/tmp/alpha', CODEX_IDLE_OUTPUT);
    tmuxHarness.createSession('beta-session', '/tmp/beta', CODEX_IDLE_OUTPUT);

    const app = await createTestApp();
    const db = await import('./db.js');
    const taskDispatcher = await import('./task-dispatcher.js');
    const eventBus = await import('./event-bus.js');

    const liveMessages: string[] = [];
    const liveWriter = {
      id: 'live-writer',
      write: (data: string) => liveMessages.push(data),
      close: () => {},
    };
    eventBus.subscribe(liveWriter);

    const agentA = await adoptAgent(app, 'alpha-session', 'codex', 'alpha');
    const agentB = await adoptAgent(app, 'beta-session', 'codex', 'beta');

    const taskA = await createTask(app, {
      prompt: 'Implement the shared session store',
      agent_id: agentA.id,
    });
    const taskB = await createTask(app, {
      prompt: 'Connect the dashboard to the session store',
      agent_id: agentB.id,
      depends_on: [taskA.id],
    });

    await taskDispatcher.dispatchNext({ manual: true });
    await vi.advanceTimersByTimeAsync(0);
    await completeAdoptedRun('alpha-session');
    await taskDispatcher.dispatchNext({ manual: true });
    await vi.advanceTimersByTimeAsync(0);
    await completeAdoptedRun('beta-session');

    eventBus.unsubscribe(liveWriter);

    const liveTypes = extractEventTypes(liveMessages);
    expect(liveTypes).toEqual(expect.arrayContaining([
      'agent.adopted',
      'task.created',
      'task.dispatched',
      'run.started',
      'run.finished',
      'task.completed',
      'message.created',
    ]));
    expect(liveTypes.indexOf('task.dispatched')).toBeGreaterThan(liveTypes.indexOf('task.created'));
    expect(liveTypes.indexOf('message.created')).toBeGreaterThan(liveTypes.indexOf('task.completed'));

    const allEvents = db.listEvents();
    const replayMessages: string[] = [];
    const replayWriter = {
      id: 'replay-writer',
      write: (data: string) => replayMessages.push(data),
      close: () => {},
    };
    eventBus.subscribe(replayWriter, allEvents[0]?.id);
    eventBus.unsubscribe(replayWriter);

    const replayTypes = extractEventTypes(replayMessages);
    expect(replayTypes).toEqual(expect.arrayContaining([
      'task.dispatched',
      'run.finished',
      'message.created',
    ]));
    expect(replayMessages.length).toBeGreaterThan(0);

    const resultMessages = db.listAgentMessages({ to_agent_id: agentB.id });
    expect(resultMessages.some((message) => message.message_type === 'result')).toBe(true);

    expect(db.getTask(taskA.id).ok).toBe(true);
    expect(db.getTask(taskB.id).ok).toBe(true);
  });
});

async function setupEnvironment(options?: {
  autoDispatch?: boolean;
  hangTimeoutMin?: number;
}): Promise<{ tempDir: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-agent-runtime-'));
  tempDirs.push(tempDir);

  const configPath = path.join(tempDir, 'config.yaml');
  fs.writeFileSync(configPath, makeConfigYaml(tempDir, options), 'utf-8');

  const config = await import('./config.js');
  config.loadConfig(configPath);

  const db = await import('./db.js');
  db.initDb(path.join(tempDir, 'wavecode.db'));

  const taskDispatcher = await import('./task-dispatcher.js');
  taskDispatcher.resetDispatcherForTest();

  return { tempDir };
}

async function createTestApp() {
  const { registerAgentRoutes } = await import('./routes/agents.js');
  const { registerTaskRoutes } = await import('./routes/tasks.js');

  const app = new Hono();
  registerAgentRoutes(app);
  registerTaskRoutes(app);
  return app;
}

async function adoptAgent(
  app: Hono,
  sessionName: string,
  runtime: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await postJson(app, '/api/agents/adopt', {
    sessionName,
    runtime,
    name,
  });

  expect(response.status).toBe(201);
  return response.json as { id: string; name: string };
}

async function createTask(
  app: Hono,
  body: {
    prompt: string;
    agent_id?: string;
    depends_on?: string[];
  },
): Promise<{ id: string }> {
  const response = await postJson(app, '/api/tasks', body);
  expect(response.status).toBe(201);
  return response.json as { id: string };
}

async function postJson(app: Hono, url: string, body: unknown) {
  const response = await app.fetch(new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));

  return {
    status: response.status,
    json: await response.json(),
  };
}

async function completeAdoptedRun(sessionName: string): Promise<void> {
  tmuxHarness.setOutput(sessionName, CODEX_WORKING_OUTPUT);
  await vi.advanceTimersByTimeAsync(2000);
  tmuxHarness.setOutput(sessionName, CODEX_IDLE_OUTPUT);
  await vi.advanceTimersByTimeAsync(8000);
}

function extractEventTypes(messages: string[]): string[] {
  return messages
    .map((message) => message.match(/^event: (.+)$/m)?.[1] ?? null)
    .filter((type): type is string => !!type);
}

function makeConfigYaml(tempDir: string, options?: {
  autoDispatch?: boolean;
  hangTimeoutMin?: number;
}): string {
  const autoDispatch = options?.autoDispatch ?? false;
  const hangTimeoutMin = options?.hangTimeoutMin ?? 10;

  return `
server:
  port: 3777
  host: 127.0.0.1

paths:
  projects_root: ${tempDir}/projects
  worktrees_root: ${tempDir}/worktrees
  transcripts_root: ${tempDir}/transcripts
  teams_root: ${tempDir}/teams
  guides_root: ${tempDir}/guides
  templates_root: ${tempDir}/templates

autonomy:
  auto_dispatch: ${autoDispatch}
  auto_restart: true
  hang_timeout_min: ${hangTimeoutMin}
  max_task_retries: 2

runtimes:
  codex:
    command: codex --full-auto
    idle_pattern: '^>\\s*$'
  claude-code:
    command: claude --permission-mode bypassPermissions
    idle_pattern: '\\$\\s*$'

auth:
  method: token
  fallback_token: test-token
  trusted_proxies: []
`.trimStart();
}
