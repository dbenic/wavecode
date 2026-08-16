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
  detectPermissionMode,
  detectStatus,
  isClaudeBypassAcceptDialog,
  maybeDismissFirstRunDialog,
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

    it('detects working with thinking indicator', () => {
      const output = `
Previous output
✻ Brewing... (45s)
⏵⏵ claude-code (shift+tab to cycle)
`.trim();
      expect(detectStatus(output, 'claude-code')).toBe('working');
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
