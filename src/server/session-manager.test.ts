import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
  },
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

vi.mock('./db.js', () => ({
  getDb: vi.fn(),
  isEffortLevel: vi.fn((v) => ['low', 'medium', 'high', 'xhigh'].includes(v)),
  insertAgent: vi.fn((agent) => ({
    ok: true,
    data: {
      id: 'agent-1',
      created_at: '2026-01-01T00:00:00.000Z',
      ...agent,
    },
  })),
  getAgent: vi.fn(),
  getAgentByName: vi.fn(),
  listAgents: vi.fn(() => []),
  deleteAgent: vi.fn(),
  updateAgentStatus: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    paths: {
      projects_root: '/tmp/projects',
    },
    runtimes: {
      codex: {
        command: 'codex --full-auto',
        idle_pattern: '^>\\s*$',
      },
    },
  })),
}));

vi.mock('./runner.js', () => ({
  startRunner: vi.fn(),
  stopRunner: vi.fn(),
}));

vi.mock('./runtime-launcher.js', () => ({
  createWorktree: vi.fn(),
  launchRuntimeInNewSession: vi.fn(() => ({ ok: true, data: undefined })),
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(() => false),
  killSession: vi.fn(),
  listSessions: vi.fn(),
  sendRawKey: vi.fn(),
}));

describe('session-manager.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the projects_root/<agent-name> directory as the agent workspace', async () => {
    const childProcess = await import('node:child_process');
    const db = await import('./db.js');
    const config = await import('./config.js');
    const runtimeLauncher = await import('./runtime-launcher.js');
    const runner = await import('./runner.js');
    const sessionManager = await import('./session-manager.js');

    vi.mocked(config.getConfig).mockReturnValue({
      paths: {
        projects_root: '/tmp/projects',
      },
      runtimes: {
        codex: {
          command: 'codex --full-auto',
          idle_pattern: '^>\\s*$',
        },
      },
    } as ReturnType<typeof config.getConfig>);

    existsSyncMock.mockReturnValue(false);

    const result = sessionManager.spawnAgent({
      name: 'co-ops-dev',
      runtime: 'codex',
    });

    expect(result.ok).toBe(true);
    expect(mkdirSyncMock).toHaveBeenCalledWith('/tmp/projects/co-ops-dev', { recursive: true });
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      'git',
      ['init', '-b', 'main'],
      { cwd: '/tmp/projects/co-ops-dev', timeout: 5000 },
    );
    expect(vi.mocked(runtimeLauncher.launchRuntimeInNewSession)).toHaveBeenCalledWith({
      sessionName: 'wc-co-ops-dev',
      workDir: '/tmp/projects/co-ops-dev',
      runtime: 'codex',
      model: null,
      effort: null,
    });
    expect(vi.mocked(db.insertAgent)).toHaveBeenCalledWith(expect.objectContaining({
      workspace: '/tmp/projects/co-ops-dev',
    }));
    expect(vi.mocked(runner.startRunner)).toHaveBeenCalledWith('agent-1', 'wc-co-ops-dev', 'codex');
  });

  it('records and forwards model/effort pins when spawning', async () => {
    const db = await import('./db.js');
    const runtimeLauncher = await import('./runtime-launcher.js');
    const sessionManager = await import('./session-manager.js');

    existsSyncMock.mockReturnValue(false);

    const result = sessionManager.spawnAgent({
      name: 'grok-fe',
      runtime: 'codex',
      model: 'grok-4.6',
      effort: 'xhigh',
    });

    expect(result.ok).toBe(true);
    expect(vi.mocked(runtimeLauncher.launchRuntimeInNewSession)).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'grok-4.6', effort: 'xhigh' }),
    );
    expect(vi.mocked(db.insertAgent)).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'grok-4.6', effort: 'xhigh' }),
    );
  });

  it('rejects unsafe model names before anything launches', async () => {
    const db = await import('./db.js');
    const runtimeLauncher = await import('./runtime-launcher.js');
    const sessionManager = await import('./session-manager.js');

    const result = sessionManager.spawnAgent({
      name: 'evil',
      runtime: 'codex',
      model: 'x; rm -rf /',
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('Invalid model name');
    expect(vi.mocked(runtimeLauncher.launchRuntimeInNewSession)).not.toHaveBeenCalled();
    expect(vi.mocked(db.insertAgent)).not.toHaveBeenCalled();
  });

  it('kill() stops the runner, kills the tmux session, and deletes the record', async () => {
    const db = await import('./db.js');
    const runner = await import('./runner.js');
    const tmux = await import('./tmux.js');
    const sessionManager = await import('./session-manager.js');

    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-9', name: 'doomed', runtime: 'codex', tmux_session: 'wc-doomed',
        workspace: null, mode: 'spawned', status: 'idle', model: null, effort: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    });
    vi.mocked(db.deleteAgent).mockReturnValue({ ok: true, data: undefined });

    const result = sessionManager.kill('agent-9');

    expect(result.ok).toBe(true);
    expect(vi.mocked(runner.stopRunner)).toHaveBeenCalledWith('agent-9');
    expect(vi.mocked(tmux.killSession)).toHaveBeenCalledWith('wc-doomed');
    expect(vi.mocked(db.deleteAgent)).toHaveBeenCalledWith('agent-9');
  });

  it('kill() refuses adopted agents', async () => {
    const db = await import('./db.js');
    const tmux = await import('./tmux.js');
    const sessionManager = await import('./session-manager.js');

    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-a', name: 'external', runtime: 'claude-code', tmux_session: 'my-session',
        workspace: null, mode: 'adopted', status: 'idle', model: null, effort: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = sessionManager.kill('agent-a');

    expect(result.ok).toBe(false);
    expect(vi.mocked(tmux.killSession)).not.toHaveBeenCalled();
  });

  it('detach() stops the runner but leaves the tmux session alive', async () => {
    const db = await import('./db.js');
    const runner = await import('./runner.js');
    const tmux = await import('./tmux.js');
    const sessionManager = await import('./session-manager.js');

    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-d', name: 'detachee', runtime: 'codex', tmux_session: 'wc-detachee',
        workspace: null, mode: 'spawned', status: 'idle', model: null, effort: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    });
    vi.mocked(db.deleteAgent).mockReturnValue({ ok: true, data: undefined });

    const result = sessionManager.detach('agent-d');

    expect(result.ok).toBe(true);
    expect(vi.mocked(runner.stopRunner)).toHaveBeenCalledWith('agent-d');
    expect(vi.mocked(db.deleteAgent)).toHaveBeenCalledWith('agent-d');
    expect(vi.mocked(tmux.killSession)).not.toHaveBeenCalled();
  });

  it('stopAll() kills spawned agents and interrupts adopted ones', async () => {
    const db = await import('./db.js');
    const tmux = await import('./tmux.js');
    const sessionManager = await import('./session-manager.js');

    const spawned = {
      id: 'agent-s', name: 'spawned-one', runtime: 'codex', tmux_session: 'wc-spawned-one',
      workspace: null, mode: 'spawned' as const, status: 'working' as const,
      model: null, effort: null, created_at: '2026-01-01T00:00:00.000Z',
    };
    const adopted = {
      id: 'agent-o', name: 'adopted-one', runtime: 'claude-code', tmux_session: 'ext-session',
      workspace: null, mode: 'adopted' as const, status: 'working' as const,
      model: null, effort: null, created_at: '2026-01-01T00:00:00.000Z',
    };

    vi.mocked(db.listAgents).mockReturnValueOnce([spawned, adopted]);
    vi.mocked(db.getAgent).mockReturnValueOnce({ ok: true, data: spawned });
    vi.mocked(db.deleteAgent).mockReturnValueOnce({ ok: true, data: undefined });
    vi.mocked(tmux.hasSession).mockReturnValueOnce(true);

    const summary = sessionManager.stopAll();

    expect(summary.killed).toEqual(['agent-s']);
    expect(summary.interrupted).toEqual(['agent-o']);
    expect(summary.errors).toEqual([]);
    expect(vi.mocked(tmux.killSession)).toHaveBeenCalledWith('wc-spawned-one');
    expect(vi.mocked(tmux.sendRawKey)).toHaveBeenCalledWith('ext-session', 'C-c');
  });

  it('stopAll() records per-agent errors without aborting', async () => {
    const db = await import('./db.js');
    const tmux = await import('./tmux.js');
    const sessionManager = await import('./session-manager.js');

    const adopted = {
      id: 'agent-e', name: 'flaky', runtime: 'claude-code', tmux_session: 'ext-flaky',
      workspace: null, mode: 'adopted' as const, status: 'working' as const,
      model: null, effort: null, created_at: '2026-01-01T00:00:00.000Z',
    };
    vi.mocked(db.listAgents).mockReturnValueOnce([adopted]);
    vi.mocked(tmux.hasSession).mockReturnValueOnce(true);
    vi.mocked(tmux.sendRawKey).mockImplementationOnce(() => {
      throw new Error('tmux exploded');
    });

    const summary = sessionManager.stopAll();

    expect(summary.killed).toEqual([]);
    expect(summary.interrupted).toEqual([]);
    expect(summary.errors).toEqual([{ agent: 'flaky', error: 'tmux exploded' }]);
  });

  it('rejects spawned agents when no workspace can be resolved', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const runtimeLauncher = await import('./runtime-launcher.js');
    const runner = await import('./runner.js');
    const sessionManager = await import('./session-manager.js');

    vi.mocked(config.getConfig).mockReturnValue({
      paths: {
        projects_root: '',
      },
      runtimes: {
        codex: {
          command: 'codex --full-auto',
          idle_pattern: '^>\\s*$',
        },
      },
    } as ReturnType<typeof config.getConfig>);

    const result = sessionManager.spawnAgent({
      name: 'builder',
      runtime: 'codex',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('require a workspace');
    expect(vi.mocked(runtimeLauncher.launchRuntimeInNewSession)).not.toHaveBeenCalled();
    expect(vi.mocked(db.insertAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(runner.startRunner)).not.toHaveBeenCalled();
  });
});
