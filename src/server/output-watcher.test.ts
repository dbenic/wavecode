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

  it('sends Down then Enter and honors the cooldown', () => {
    const t0 = 1_000_000;
    expect(maybeDismissFirstRunDialog('agent-1', dialog, t0)).toBe(true);
    expect(sendRawKeys).toHaveBeenNthCalledWith(1, 'agent-1', 'Down');
    expect(sendRawKeys).toHaveBeenNthCalledWith(2, 'agent-1', 'Enter');

    expect(maybeDismissFirstRunDialog('agent-1', dialog, t0 + CLAUDE_BYPASS_DIALOG_COOLDOWN_MS - 1)).toBe(false);
    expect(sendRawKeys).toHaveBeenCalledTimes(2);

    expect(maybeDismissFirstRunDialog('agent-1', dialog, t0 + CLAUDE_BYPASS_DIALOG_COOLDOWN_MS)).toBe(true);
    expect(sendRawKeys).toHaveBeenCalledTimes(4);
  });

  it('does not send keys for unrelated pane text', () => {
    expect(maybeDismissFirstRunDialog('agent-1', 'REVIEW PASS: no issues found.')).toBe(false);
    expect(sendRawKeys).not.toHaveBeenCalled();
  });
});
