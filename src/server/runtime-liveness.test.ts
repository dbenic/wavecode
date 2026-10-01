/**
 * T0 runtime liveness — simulated pane captures, no real tmux.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from './db.js';

const pane = { text: '', alive: true };

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(() => pane.alive),
  capturePane: vi.fn(() => ({ ok: true, data: pane.text })),
  sendTextAndEnter: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    runtimes: {
      'claude-code': { command: 'claude --dangerously-skip-permissions', idle_pattern: '>', model_flag: '--model', effort_flag: '--effort' },
    },
  })),
}));

vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import * as tmux from './tmux.js';
import { emit } from './event-bus.js';
import {
  RUNTIME_NOT_RUNNING,
  ensureRuntimeAlive,
  getRuntimeState,
  isBareShellPrompt,
  relaunchRuntime,
  resetRuntimeLivenessForTest,
} from './runtime-liveness.js';

const CLAUDE_TUI = [
  '● Done. Updated src/server/auth.ts',
  '',
  '╭──────────────────────────────────────────╮',
  '│ >                                        │',
  '╰──────────────────────────────────────────╯',
  '  ? for shortcuts',
].join('\n');

const BARE_SHELL = [
  '● Goodbye!',
  'ci@wavecode-box:~/.wavecode-data/worktrees/builder$ ',
  '',
  '',
].join('\n');

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'claude-code',
    tmux_session: 'wc-builder',
    workspace: '/tmp/builder',
    mode: 'spawned',
    status: 'idle',
    model: 'claude-sonnet-5',
    effort: 'high',
    created_at: '',
    ...overrides,
  };
}

describe('runtime-liveness.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetRuntimeLivenessForTest();
    pane.text = CLAUDE_TUI;
    pane.alive = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isBareShellPrompt', () => {
    it.each([
      'ci@wavecode-box:~/repo$ ',
      'root@srv:/srv/app# ',
      '(venv) ana@laptop:~/proj$',
      'bash-5.2$ ',
      '$ ',
      'denis@mac ~ % ',
      '\x1b[01;32mci@box\x1b[00m:\x1b[01;34m~\x1b[00m$ ',
    ])('treats %j as a bare shell prompt', (line) => {
      expect(isBareShellPrompt(`some output\n${line}\n\n`)).toBe(true);
    });

    it.each([
      ['an alive Claude TUI', CLAUDE_TUI],
      ['a command being relaunched', 'ci@box:~/repo$ claude --model x'],
      ['a codex TUI prompt', '▌ Ask Codex to do anything\n ⏎ send   ⌃J newline'],
      ['a glyph prompt TUIs also use', '❯ '],
      ['prose ending in a dollar amount', 'Total cost: $'],
      ['an empty pane', '\n\n'],
    ])('does not flag %s', (_label, text) => {
      expect(isBareShellPrompt(text)).toBe(false);
    });
  });

  describe('getRuntimeState', () => {
    it('alive TUI → alive; bare shell → dead; no session → unknown', () => {
      expect(getRuntimeState(agent())).toBe('alive');
      pane.text = BARE_SHELL;
      expect(getRuntimeState(agent())).toBe('dead');
      pane.alive = false;
      expect(getRuntimeState(agent())).toBe('unknown');
    });
  });

  describe('ensureRuntimeAlive', () => {
    it('alive TUI: no relaunch, nothing typed', async () => {
      const result = await ensureRuntimeAlive(agent());
      expect(result).toEqual({ ok: true, data: { relaunched: false } });
      expect(tmux.sendTextAndEnter).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('bare shell → relaunch succeeds: types the pinned runtime command, emits, waits to settle', async () => {
      pane.text = BARE_SHELL;
      vi.mocked(tmux.sendTextAndEnter).mockImplementationOnce(() => {
        // Echo then the TUI boots a few seconds later
        pane.text = 'ci@wavecode-box:~/repo$ claude --dangerously-skip-permissions --model claude-sonnet-5 --effort high';
        setTimeout(() => { pane.text = CLAUDE_TUI; }, 3000);
      });

      const pending = ensureRuntimeAlive(agent());
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toEqual({ ok: true, data: { relaunched: true } });
      expect(tmux.sendTextAndEnter).toHaveBeenCalledTimes(1);
      expect(tmux.sendTextAndEnter).toHaveBeenCalledWith(
        'wc-builder',
        'claude --dangerously-skip-permissions --model claude-sonnet-5 --effort high',
      );
      expect(emit).toHaveBeenCalledWith('agent.runtime_relaunched', 'agent', 'agent-1', expect.objectContaining({
        runtime: 'claude-code', model: 'claude-sonnet-5', effort: 'high', reason: 'dispatch',
      }));
    });

    it('relaunch timeout: pane stays at the shell for 30s → runtime not running', async () => {
      pane.text = BARE_SHELL;
      vi.mocked(tmux.sendTextAndEnter).mockImplementationOnce(() => {
        pane.text = 'ci@box:~$ claude\nbash: claude: command not found\nci@box:~$ ';
      });

      const pending = ensureRuntimeAlive(agent());
      await vi.advanceTimersByTimeAsync(29_000);
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toEqual({ ok: false, error: RUNTIME_NOT_RUNNING });
      expect(tmux.sendTextAndEnter).toHaveBeenCalledTimes(1); // never typed the task into bash
    });

    it('requires the pane to stay off the prompt — a brief flash of output is not enough', async () => {
      pane.text = BARE_SHELL;
      vi.mocked(tmux.sendTextAndEnter).mockImplementationOnce(() => {
        pane.text = 'ci@box:~$ claude';
        setTimeout(() => { pane.text = 'ci@box:~$ '; }, 1500); // crashed straight back
      });
      const pending = ensureRuntimeAlive(agent(), { timeoutMs: 5_000 });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await pending).toEqual({ ok: false, error: RUNTIME_NOT_RUNNING });
    });

    it('unknown runtime → runtime not running without typing anything', async () => {
      pane.text = BARE_SHELL;
      const result = await ensureRuntimeAlive(agent({ runtime: 'mystery' }));
      expect(result).toEqual({ ok: false, error: RUNTIME_NOT_RUNNING });
      expect(tmux.sendTextAndEnter).not.toHaveBeenCalled();
    });
  });

  describe('relaunchRuntime', () => {
    it('does not double-launch within the settle window (monitor tick + dispatch)', () => {
      expect(relaunchRuntime(agent(), 'health_check')).toEqual({ ok: true, data: { sent: true } });
      expect(relaunchRuntime(agent(), 'dispatch')).toEqual({ ok: true, data: { sent: false } });
      vi.advanceTimersByTime(31_000);
      expect(relaunchRuntime(agent(), 'dispatch')).toEqual({ ok: true, data: { sent: true } });
      expect(tmux.sendTextAndEnter).toHaveBeenCalledTimes(2);
    });

    it('stops after MAX_RELAUNCH_ATTEMPTS until the runtime is seen alive again', async () => {
      const { MAX_RELAUNCH_ATTEMPTS, noteRuntimeAlive, relaunchAttemptsExhausted } = await import('./runtime-liveness.js');

      for (let i = 0; i < MAX_RELAUNCH_ATTEMPTS; i++) {
        expect(relaunchRuntime(agent(), 'health_check')).toEqual({ ok: true, data: { sent: true } });
        vi.advanceTimersByTime(31_000);
      }
      expect(tmux.sendTextAndEnter).toHaveBeenCalledTimes(MAX_RELAUNCH_ATTEMPTS);

      // Budget exhausted: a fast-failing runtime command is never retyped forever
      const refused = relaunchRuntime(agent(), 'health_check');
      expect(refused.ok).toBe(false);
      expect(refused.ok ? '' : refused.error).toMatch(/exhausted/);
      expect(relaunchAttemptsExhausted('agent-1')).toBe(true);
      expect(tmux.sendTextAndEnter).toHaveBeenCalledTimes(MAX_RELAUNCH_ATTEMPTS);

      // Seen alive (e.g. a human fixed it) → budget resets
      noteRuntimeAlive('agent-1');
      expect(relaunchAttemptsExhausted('agent-1')).toBe(false);
      expect(relaunchRuntime(agent(), 'health_check')).toEqual({ ok: true, data: { sent: true } });
    });
  });
});
