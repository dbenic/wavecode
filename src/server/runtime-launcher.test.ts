import { describe, it, expect, vi, afterEach } from 'vitest';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    paths: {
      worktrees_root: '/tmp/wavecode/worktrees',
      transcripts_root: '/tmp/wavecode/transcripts',
      teams_root: '/tmp/wavecode/teams',
    },
    runtimes: {
      'claude-code': {
        command: 'claude --permission-mode bypassPermissions',
        idle_pattern: '\\$\\s*$',
      },
      codex: {
        command: 'codex --full-auto',
        idle_pattern: '^>\\s*$',
      },
    },
  })),
}));

vi.mock('./tmux.js', () => ({
  newSession: vi.fn(),
}));

describe('runtime-launcher.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('creates git worktrees under the configured root', async () => {
    const { createWorktree } = await import('./runtime-launcher.js');

    const result = createWorktree('agent-a', '/repo/project', 'wc-agent-a');

    expect(result.ok).toBe(true);
    expect(vi.mocked(child_process.execFileSync)).toHaveBeenCalledWith(
      'mkdir',
      ['-p', '/tmp/wavecode/worktrees'],
      { timeout: 5000 },
    );
    expect(vi.mocked(child_process.execFileSync)).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/project', 'worktree', 'add', '/tmp/wavecode/worktrees/agent-a', '-b', 'wc-agent-a'],
      expect.objectContaining({ timeout: 15000 }),
    );
  });

  it('launches codex with the configured command', async () => {
    const tmux = await import('./tmux.js');
    const { launchRuntimeInNewSession } = await import('./runtime-launcher.js');

    const result = launchRuntimeInNewSession({
      sessionName: 'wc-codex',
      workDir: '/repo/project',
      runtime: 'codex',
    });

    expect(result.ok).toBe(true);
    expect(vi.mocked(tmux.newSession)).toHaveBeenCalledWith(
      'wc-codex',
      '/repo/project',
      'codex --full-auto',
    );
  });

  it('launches claude-code with the configured command', async () => {
    const tmux = await import('./tmux.js');
    const { launchRuntimeInNewSession } = await import('./runtime-launcher.js');

    const result = launchRuntimeInNewSession({
      sessionName: 'wc-claude',
      workDir: '/repo/project',
      runtime: 'claude-code',
    });

    expect(result.ok).toBe(true);
    expect(vi.mocked(tmux.newSession)).toHaveBeenCalledWith(
      'wc-claude',
      '/repo/project',
      'claude --permission-mode bypassPermissions',
    );
  });

  it('returns error for unknown runtime', async () => {
    const { launchRuntimeInNewSession } = await import('./runtime-launcher.js');

    const result = launchRuntimeInNewSession({
      sessionName: 'wc-unknown',
      workDir: '/repo/project',
      runtime: 'nonexistent',
    });

    expect(result.ok).toBe(false);
  });
});
