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
    });
    expect(vi.mocked(db.insertAgent)).toHaveBeenCalledWith(expect.objectContaining({
      workspace: '/tmp/projects/co-ops-dev',
    }));
    expect(vi.mocked(runner.startRunner)).toHaveBeenCalledWith('agent-1', 'wc-co-ops-dev', 'codex');
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
