/**
 * Phase 3 Tests — output-watcher.ts (status detection, tick guard)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({
  sendRawKeys: vi.fn(() => ({ ok: true, data: undefined })),
  capturePane: vi.fn(),
}));

import {
  CLAUDE_BYPASS_DIALOG_COOLDOWN_MS,
  IDLE_CLOSE_GRACE_MS,
  detectPermissionMode,
  detectStatus,
  extractFinishedRunIdsFromPane,
  isClaudeBypassAcceptDialog,
  isWithinIdleCloseGrace,
  maybeDismissFirstRunDialog,
  parseRunStartedAtMs,
  resetFirstRunDialogStateForTest,
  runShowedWorkingAfterStart,
} from './output-watcher.js';
import { sendRawKeys } from './session-manager.js';

describe('output-watcher — status detection', () => {
  describe('Claude Code', () => {
    it('detects working when "esc to interrupt" is in status bar', () => {
      const output = `
Some output here
✻ Improvising...
⏵⏵ claude-code (shift+tab to cycle) · esc to interrupt
`.trim();
      expect(detectStatus(output, 'claude-code')).toBe('working');
    });

    it('detects idle when status bar present but no interrupt', () => {
      const output = `
Done! Created auth.ts
Brewed for 2m 30s
⏵⏵ claude-code (shift+tab to cycle)
`.trim();
      expect(detectStatus(output, 'claude-code')).toBe('idle');
    });

    it('detects working with thinking indicator and esc to interrupt', () => {
      const output = `
Previous output
✻ Brewing... (45s)
⏵⏵ claude-code (shift+tab to cycle) · esc to interrupt
`.trim();
      expect(detectStatus(output, 'claude-code')).toBe('working');
    });

    it('detects idle on a fresh Claude splash (sparkle + tip + shift+tab, no interrupt)', () => {
      const output = `
     ✻ Welcome to Claude Code

     Try refactor db.ts

     bypass permissions on (shift+tab to cycle) · gh auth login for PR status
`.trim();
      expect(detectStatus(output, 'claude-code')).toBe('idle');
    });

    it('detects idle when the splash sparkle sits above an idle ⏵⏵ bar', () => {
      const output = `
✶ Claude Code
Try refactor db.ts
⏵⏵ bypass permissions on (shift+tab to cycle)
`.trim();
      expect(detectStatus(output, 'claude-code')).toBe('idle');
    });

    it('detects working from an action-verb status line while actually running', () => {
      expect(detectStatus('✻ Brewing... (45s)', 'claude-code')).toBe('working');
      expect(detectStatus('Some output\n✶ Creating... (12s)', 'claude-code')).toBe('working');
    });
  });

  describe('Codex CLI', () => {
    it('detects working with "Working" indicator', () => {
      const output = `
Some code output
◦ Working (12s • esc to interrupt)
gpt-5.4 xhigh · 47% left · ~/project
`.trim();
      expect(detectStatus(output, 'codex')).toBe('working');
    });

    it('detects idle with prompt', () => {
      const output = `
Output done
gpt-5.4 xhigh · 47% left · ~/project
›
`.trim();
      expect(detectStatus(output, 'codex')).toBe('idle');
    });

    it('Codex 0.16x: finished turn ("Worked for …") with the capitalised model footer is idle, not hung', () => {
      const output = `
• Re-read the updated operating rules, ROOM.md, and SystemOps testing brief.
  • Fable remains the sole production deployer.
  RESULT: PASS
  └ Tip: Use /vim to toggle Vim editing in the composer.
  Worked for 14s • 11:01 AM
› Ask Codex to do anything
  GPT-5.6-Sol low · ~/.wavecode-data/worktrees/codex2 · Document invoice data pipeline
  ? for shortcuts                                              ⚠ 2 warnings · f2 to view
`.trim();
      expect(detectStatus(output, 'codex')).toBe('idle');
    });

    it('Codex 0.16x: a running turn with the capitalised footer is working', () => {
      const output = `
• Thinking about the migration order
◦ Working (31s • esc to interrupt)
  GPT-6-Astra high · ~/.wavecode-data/seats/pm-antonio · Check source code access
  ? for shortcuts
`.trim();
      expect(detectStatus(output, 'codex')).toBe('working');
    });
  });

  describe('Aider', () => {
    it('detects idle at prompt', () => {
      expect(detectStatus('some output\n> ', 'aider')).toBe('idle');
    });
  });

  describe('Grok CLI', () => {
    it('detects working while Responding', () => {
      const output = `
Earlier context
RESULT: PASS
Responding…
`.trim();
      expect(detectStatus(output, 'grok')).toBe('working');
    });

    it('detects working while Thinking', () => {
      const output = `
Planning the change
✦ Thinking
`.trim();
      expect(detectStatus(output, 'grok')).toBe('working');
    });

    it('detects working for Worked-for and the TUI interrupt line', () => {
      expect(detectStatus('Worked for 12s\nGenerating a patch', 'grok')).toBe('working');
      expect(detectStatus('esc to interrupt\nwriting files', 'grok')).toBe('working');
    });

    it('detects idle at the Grok prompt after a RESULT line', () => {
      const output = `
Implement the gate
RESULT: PASS lint=PASS unit=PASS
>
`.trim();
      expect(detectStatus(output, 'grok')).toBe('idle');
    });

    it('does not treat a RESULT line alone as working', () => {
      const output = `
Done with the review
RESULT: PASS
`.trim();
      expect(detectStatus(output, 'grok')).toBe('idle');
    });
  });

  describe('pane run_id binding', () => {
    const grokRunId = '01M0886K75AJDRRR1BPTA4X7ZC';
    const grokTaskId = '01M0886JQC1ZME43DW286V36YM';
    const laterRunId = '01M0829117QXE7QP6GNG8EPQQT';

    it('binds the echo|nc run_id that appears before RESULT PASS', () => {
      const output = [
        `echo '{"type":"run.started","run_id":"${grokRunId}","task_id":"${grokTaskId}","agent_id":"agent-1"}' | nc -U '/tmp/wavecode-runner-agent-1.sock' 2>/dev/null; echo 'do the work' | grok --always-approve;`,
        'RESULT: PASS lint=PASS unit=PASS',
        '>',
      ].join('\n');
      expect(extractFinishedRunIdsFromPane(output)).toEqual([grokRunId]);
    });

    it('does not bind a later echo|nc pasted after RESULT (new task)', () => {
      const output = [
        `echo '{"type":"run.started","run_id":"${grokRunId}","task_id":"${grokTaskId}"}' | nc -U '/tmp/wavecode-runner-agent-1.sock' 2>/dev/null;`,
        'RESULT: PASS',
        `echo '{"type":"run.started","run_id":"${laterRunId}","task_id":"01M0NEWTASK000000000000000"}' | nc -U '/tmp/wavecode-runner-agent-1.sock' 2>/dev/null;`,
        '◦ Working (3s • esc to interrupt)',
        'gpt-5.4 xhigh · 47% left · ~/project',
      ].join('\n');
      expect(extractFinishedRunIdsFromPane(output)).toEqual([grokRunId]);
    });
  });

  describe('Error detection', () => {
    it('detects FATAL errors', () => {
      expect(detectStatus('FATAL: out of memory', 'claude-code')).toBe('error');
    });

    it('detects panic errors', () => {
      expect(detectStatus('panic: runtime error', 'claude-code')).toBe('error');
    });
  });

  describe('Shell prompt', () => {
    it('detects idle at shell prompt', () => {
      expect(detectStatus('user@host:~/project$ ', 'claude-code')).toBe('idle');
    });
  });

  describe('Permission mode detection', () => {
    it('detects bypass permission mode', () => {
      expect(detectPermissionMode('Running with dangerously-skip permissions')).toBe('bypass');
    });

    it('detects ask permission mode', () => {
      expect(detectPermissionMode('Do you want to proceed? Enter to confirm')).toBe('ask');
    });
  });
});

describe('output-watcher — idle-close dispatch grace', () => {
  it('parses SQLite datetime(now) and ISO started_at', () => {
    expect(parseRunStartedAtMs('2026-08-19 10:00:00')).toBe(Date.parse('2026-08-19T10:00:00Z'));
    expect(parseRunStartedAtMs('2026-08-19T10:00:00Z')).toBe(Date.parse('2026-08-19T10:00:00Z'));
    expect(parseRunStartedAtMs('')).toBeNull();
    expect(parseRunStartedAtMs('not-a-date')).toBeNull();
  });

  it('treats a just-started run as inside grace and an aged run as outside', () => {
    const now = Date.parse('2026-08-19T10:01:00Z');
    expect(isWithinIdleCloseGrace('2026-08-19 10:00:30', now)).toBe(true);
    expect(isWithinIdleCloseGrace('2026-08-19T10:00:30.000Z', now)).toBe(true);
    expect(isWithinIdleCloseGrace('2026-08-19T09:59:00Z', now)).toBe(false);
    expect(isWithinIdleCloseGrace('2026-08-19T10:00:00Z', now + IDLE_CLOSE_GRACE_MS)).toBe(false);
    expect(isWithinIdleCloseGrace('not-a-date', now)).toBe(false);
  });

  it('treats a run as having shown working only after started_at', () => {
    const start = '2026-08-19T10:00:00Z';
    expect(runShowedWorkingAfterStart(start, null)).toBe(false);
    expect(runShowedWorkingAfterStart(start, Date.parse('2026-08-19T09:59:59Z'))).toBe(false);
    expect(runShowedWorkingAfterStart(start, Date.parse('2026-08-19T10:00:00Z'))).toBe(true);
    expect(runShowedWorkingAfterStart(start, Date.parse('2026-08-19T10:00:05Z'))).toBe(true);
  });
});

describe('output-watcher — Claude first-run dialog', () => {
  const dialog = `
Bypass Permissions

Claude Code can now bypass permissions for this session.

Do you want to proceed?

   1. No
❯  2. Yes, I accept
`.trim();

  beforeEach(() => {
    resetFirstRunDialogStateForTest();
    vi.mocked(sendRawKeys).mockClear();
    vi.mocked(sendRawKeys).mockReturnValue({ ok: true, data: undefined });
  });

  it('detects the Bypass Permissions accept dialog', () => {
    expect(isClaudeBypassAcceptDialog(dialog)).toBe(true);
    expect(isClaudeBypassAcceptDialog('Yes, I accept')).toBe(false);
    expect(isClaudeBypassAcceptDialog('Bypass Permissions only')).toBe(false);
    expect(isClaudeBypassAcceptDialog('Do you want to proceed?\nbypass mode\nYes, I accept')).toBe(true);
  });

  it('sends Down then Enter and honors the cooldown', async () => {
    const t0 = 1_000_000;
    expect((await maybeDismissFirstRunDialog('agent-1', dialog, t0))).toBe(true);
    expect(sendRawKeys).toHaveBeenNthCalledWith(1, 'agent-1', 'Down');
    expect(sendRawKeys).toHaveBeenNthCalledWith(2, 'agent-1', 'Enter');

    expect((await maybeDismissFirstRunDialog('agent-1', dialog, t0 + CLAUDE_BYPASS_DIALOG_COOLDOWN_MS - 1))).toBe(false);
    expect(sendRawKeys).toHaveBeenCalledTimes(2);

    expect((await maybeDismissFirstRunDialog('agent-1', dialog, t0 + CLAUDE_BYPASS_DIALOG_COOLDOWN_MS))).toBe(true);
    expect(sendRawKeys).toHaveBeenCalledTimes(4);
  });

  it('accepts the trust-folder check (Down, Enter) and clears press-Enter screens (Enter)', async () => {
    const trust = ' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel';
    expect((await maybeDismissFirstRunDialog('agent-2', trust, 1_000_000))).toBe(true);
    expect(sendRawKeys).toHaveBeenNthCalledWith(1, 'agent-2', 'Down');
    expect(sendRawKeys).toHaveBeenNthCalledWith(2, 'agent-2', 'Enter');
    vi.mocked(sendRawKeys).mockClear();
    const notes = ' Security notes:\n 1. Claude can make mistakes.\n 2. Due to prompt injection risks, only use it with code you trust\n Press Enter to continue…';
    expect((await maybeDismissFirstRunDialog('agent-3', notes, 1_000_000))).toBe(true);
    expect(sendRawKeys).toHaveBeenCalledTimes(1);
    expect(sendRawKeys).toHaveBeenCalledWith('agent-3', 'Enter');
    vi.mocked(sendRawKeys).mockClear();
    // an old "Press Enter to continue" far up the scrollback is not a screen
    expect((await maybeDismissFirstRunDialog('agent-4', 'Press Enter to continue…\n' + Array(10).fill('working on src/a.ts').join('\n') + '\n❯ ', 1_000_000))).toBe(false);
  });

  it('Codex: trusts the worktree (Enter) and skips the update prompt (Down, Enter) rather than updating the CLI', async () => {
    const trust = '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n› 1. Trust and continue\n  2. Back to Agent Command Center\n  enter continue · esc back';
    expect((await maybeDismissFirstRunDialog('cx-1', trust, 1_000_000))).toBe(true);
    expect(sendRawKeys).toHaveBeenCalledTimes(1);
    expect(sendRawKeys).toHaveBeenCalledWith('cx-1', 'Enter');
    vi.mocked(sendRawKeys).mockClear();
    const update = '  Release notes: https://github.com/openai/codex/releases/latest\n› 1. Update now (runs `npm install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\n  enter continue · esc skip';
    expect((await maybeDismissFirstRunDialog('cx-2', update, 1_000_000))).toBe(true);
    expect(sendRawKeys).toHaveBeenNthCalledWith(1, 'cx-2', 'Down');
    expect(sendRawKeys).toHaveBeenNthCalledWith(2, 'cx-2', 'Enter');
  });

  it('a dialog that scrolled out of the bottom of the pane is not answered again', async () => {
    const scrolled = ' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm\n'
      + Array(14).fill('  working on src/app.ts').join('\n')
      + '\n  ⚠ Usage limit reached · limit resets Oct 23, 1am\n❯ ';
    expect((await maybeDismissFirstRunDialog('agent-9', scrolled, 1_000_000))).toBe(false);
    expect(sendRawKeys).not.toHaveBeenCalled();
  });

  it('does not send keys for unrelated pane text', async () => {
    expect((await maybeDismissFirstRunDialog('agent-1', 'REVIEW PASS: no issues found.'))).toBe(false);
    expect(sendRawKeys).not.toHaveBeenCalled();
  });
});
