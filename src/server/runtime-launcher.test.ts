import { describe, it, expect, vi, afterEach } from 'vitest';
import * as child_process from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
    return { stdin: { end: () => undefined } };
  }),
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
        model_flag: '--model',
        effort_flag: '--effort',
      },
      codex: {
        command: 'codex --full-auto',
        idle_pattern: '^>\\s*$',
        model_flag: '-m',
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

  /** git as the launcher sees it: no worktree registered, the branch does not exist. */
  function gitFresh(opts: { registered?: string; branchExists?: boolean } = {}) {
    vi.mocked(child_process.execFile).mockImplementation(((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      const callback = typeof _opts === 'function' ? _opts as typeof cb : cb;
      try {
        let stdout = '';
        if (cmd === 'git') {
          if (args.includes('--porcelain')) stdout = opts.registered ? `worktree ${opts.registered}\nHEAD abc\nbranch refs/heads/x\n` : '';
          else if (args.includes('rev-parse')) {
            if (opts.branchExists) stdout = 'abc';
            else throw new Error('not a branch');
          }
        }
        callback(null, stdout, '');
      } catch (err) {
        callback(err as Error, '', '');
      }
      return { stdin: { end: () => undefined } };
    }) as never);
  }

  it('creates git worktrees under the configured root', async () => {
    gitFresh();
    const { createWorktree } = await import('./runtime-launcher.js');

    const result = await createWorktree('agent-a', '/repo/project', 'wc-agent-a');

    expect(result.ok).toBe(true);
    const calls = vi.mocked(child_process.execFile).mock.calls;
    expect(calls.some((c) => c[0] === 'mkdir' && JSON.stringify(c[1]) === JSON.stringify(['-p', '/tmp/wavecode/worktrees']) && (c[2] as { timeout?: number }).timeout === 5000)).toBe(true);
    expect(calls.some((c) => c[0] === 'git' && JSON.stringify(c[1]) === JSON.stringify(['-C', '/repo/project', 'worktree', 'add', '/tmp/wavecode/worktrees/agent-a', '-b', 'wc-agent-a']) && (c[2] as { timeout?: number }).timeout === 15000)).toBe(true);
  });

  it('spawning a name again reuses the branch a killed agent left behind, and the worktree when it still exists', async () => {
    const fs = await import('node:fs');
    gitFresh({ branchExists: true });
    const { createWorktree } = await import('./runtime-launcher.js');
    expect(await createWorktree('agent-a', '/repo/project', 'wc-agent-a')).toEqual({ ok: true, data: '/tmp/wavecode/worktrees/agent-a' });
    expect(vi.mocked(child_process.execFile).mock.calls.some((c) => c[0] === 'git' && JSON.stringify(c[1]) === JSON.stringify(['-C', '/repo/project', 'worktree', 'add', '/tmp/wavecode/worktrees/agent-a', 'wc-agent-a']))).toBe(true);
    vi.mocked(child_process.execFile).mockClear();
    gitFresh({ registered: '/tmp/wavecode/worktrees/agent-a', branchExists: true });
    const exists = vi.spyOn(fs.default, 'existsSync').mockReturnValue(true);
    expect(await createWorktree('agent-a', '/repo/project', 'wc-agent-a')).toEqual({ ok: true, data: '/tmp/wavecode/worktrees/agent-a' });
    expect(vi.mocked(child_process.execFile).mock.calls.some((c) => c[0] === 'git' && (c[1] as string[]).includes('add'))).toBe(false);
    exists.mockRestore();
  });

  it('a Codex relaunch resumes the worktree\'s own thread by id, and starts fresh when it has none', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-launch-home-'));
    const wt = path.join(home, 'wt', 'scout');
    const dir = path.join(home, 'sessions', '2026', '10', '20');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-20T09-29-18-01a158a4-ce6a-7382-b660-6f51fa7f0da9.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: '01a158a4-ce6a-7382-b660-6f51fa7f0da9', cwd: wt } }) + '\n');
    const { buildRuntimeCommand } = await import('./runtime-launcher.js');
    const codex = { command: 'codex --full-auto', idle_pattern: '^>', model_flag: '-m', resume_args: 'resume --last' };
    expect(buildRuntimeCommand(codex, { resume: true, workspace: wt, env: { CODEX_HOME: home } })).toBe(`env CODEX_HOME=${home} codex --full-auto resume 01a158a4-ce6a-7382-b660-6f51fa7f0da9`);
    expect(buildRuntimeCommand(codex, { resume: true, workspace: path.join(home, 'wt', 'other'), env: { CODEX_HOME: home } })).toBe(`env CODEX_HOME=${home} codex --full-auto`);
    expect(buildRuntimeCommand(codex, { resume: true, env: { CODEX_HOME: home } })).toBe(`env CODEX_HOME=${home} codex --full-auto`); // no workspace: never --last
    const claude = { command: 'claude', idle_pattern: '❯', resume_args: '--continue' };
    expect(buildRuntimeCommand(claude, { resume: true, workspace: wt })).toBe('claude --continue'); // Claude keeps its per-directory continue
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('launches codex with the configured command', async () => {
    const tmux = await import('./tmux.js');
    const { launchRuntimeInNewSession } = await import('./runtime-launcher.js');

    const result = await launchRuntimeInNewSession({
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

    const result = await launchRuntimeInNewSession({
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

    const result = await launchRuntimeInNewSession({
      sessionName: 'wc-unknown',
      workDir: '/repo/project',
      runtime: 'nonexistent',
    });

    expect(result.ok).toBe(false);
  });

  it('injects pinned model and effort into the launch command', async () => {
    const tmux = await import('./tmux.js');
    const { launchRuntimeInNewSession } = await import('./runtime-launcher.js');

    const result = await launchRuntimeInNewSession({
      sessionName: 'wc-claude',
      workDir: '/repo/project',
      runtime: 'claude-code',
      model: 'claude-opus-5',
      effort: 'xhigh',
    });

    expect(result.ok).toBe(true);
    expect(vi.mocked(tmux.newSession)).toHaveBeenCalledWith(
      'wc-claude',
      '/repo/project',
      'claude --permission-mode bypassPermissions --model claude-opus-5 --effort xhigh',
    );
  });

  describe('buildRuntimeCommand', () => {
    const base = { command: 'codex --full-auto', idle_pattern: '^>\\s*$' };

    it('appends the model via the configured flag', async () => {
      const { buildRuntimeCommand } = await import('./runtime-launcher.js');
      expect(buildRuntimeCommand({ ...base, model_flag: '-m' }, { model: 'grok-4.6' }))
        .toBe('codex --full-auto -m grok-4.6');
    });

    it('leaves the command unchanged when no pin or no flag is configured', async () => {
      const { buildRuntimeCommand } = await import('./runtime-launcher.js');
      expect(buildRuntimeCommand({ ...base, model_flag: '-m' }, {})).toBe('codex --full-auto');
      expect(buildRuntimeCommand(base, { model: 'grok-4.6' })).toBe('codex --full-auto');
    });

    it('appends resume_args only when asked to resume; refuses odd values', async () => {
      const { buildRuntimeCommand } = await import('./runtime-launcher.js');
      const codex = { command: 'codex --dangerously-bypass-approvals-and-sandbox', idle_pattern: '>', effort_flag: '-c model_reasoning_effort=', resume_args: 'resume --last' };
      // Codex never gets `resume --last` (the login's last thread may be another agent's): with no
      // workspace to look up it starts fresh; with one, it resumes that worktree's own thread by id.
      expect(buildRuntimeCommand(codex, { effort: 'high', resume: true })).toBe('codex --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=high');
      expect(buildRuntimeCommand(codex, { effort: 'high' })).toBe('codex --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort=high');
      const claude = { command: 'claude --dangerously-skip-permissions', idle_pattern: '$', model_flag: '--model', resume_args: '--continue' };
      expect(buildRuntimeCommand(claude, { model: 'claude-opus-5-5', resume: true })).toBe('claude --dangerously-skip-permissions --model claude-opus-5-5 --continue');
      expect(buildRuntimeCommand({ ...claude, resume_args: '--continue; rm -rf /' }, { resume: true })).toBe('claude --dangerously-skip-permissions');
    });

    it('never embeds unsafe model values or unknown efforts', async () => {
      const { buildRuntimeCommand } = await import('./runtime-launcher.js');
      expect(buildRuntimeCommand({ ...base, model_flag: '-m' }, { model: 'x; rm -rf /' }))
        .toBe('codex --full-auto');
      expect(buildRuntimeCommand({ ...base, effort_flag: '--effort' }, { effort: 'extreme' }))
        .toBe('codex --full-auto');
    });

    it('appends effort via the configured flag', async () => {
      const { buildRuntimeCommand } = await import('./runtime-launcher.js');
      expect(buildRuntimeCommand({ ...base, effort_flag: '--effort' }, { effort: 'xhigh' }))
        .toBe('codex --full-auto --effort xhigh');
    });

    it('concatenates Codex -c model_reasoning_effort= without an extra space', async () => {
      const { buildRuntimeCommand } = await import('./runtime-launcher.js');
      expect(buildRuntimeCommand(
        { ...base, effort_flag: '-c model_reasoning_effort=' },
        { effort: 'xhigh' },
      )).toBe('codex --full-auto -c model_reasoning_effort=xhigh');
      expect(buildRuntimeCommand(
        { ...base, effort_flag: '-c model_reasoning_effort=' },
        { effort: 'high' },
      )).toBe('codex --full-auto -c model_reasoning_effort=high');
    });
  });
});
