/**
 * Phase 1 Security Tests — tmux.ts (shell injection prevention)
 *
 * These tests verify that:
 * 1. All tmux calls use execFileSync (no shell injection)
 * 2. Raw key allowlist blocks arbitrary input
 * 3. Session name validation works correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import { isAllowedRawKey, isValidSessionName, sendLiteralText } from './tmux.js';

// Mock execFileSync to inspect calls without needing real tmux
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => ''),
}));

describe('tmux.ts — shell injection prevention', () => {
  beforeEach(() => {
    vi.mocked(child_process.execFileSync).mockReturnValue('');
  });

  describe('isAllowedRawKey', () => {
    it('allows standard control keys', () => {
      expect(isAllowedRawKey('C-c')).toBe(true);
      expect(isAllowedRawKey('C-d')).toBe(true);
      expect(isAllowedRawKey('C-u')).toBe(true);
      expect(isAllowedRawKey('C-m')).toBe(true);
      expect(isAllowedRawKey('Escape')).toBe(true);
      expect(isAllowedRawKey('Enter')).toBe(true);
      expect(isAllowedRawKey('Tab')).toBe(true);
    });

    it('allows confirmation keys', () => {
      expect(isAllowedRawKey('y')).toBe(true);
      expect(isAllowedRawKey('n')).toBe(true);
      expect(isAllowedRawKey('Y')).toBe(true);
      expect(isAllowedRawKey('N')).toBe(true);
    });

    it('blocks shell injection attempts', () => {
      expect(isAllowedRawKey("'; rm -rf / #")).toBe(false);
      expect(isAllowedRawKey('$(whoami)')).toBe(false);
      expect(isAllowedRawKey('`cat /etc/passwd`')).toBe(false);
      expect(isAllowedRawKey('C-c; echo pwned')).toBe(false);
      expect(isAllowedRawKey('')).toBe(false);
      expect(isAllowedRawKey('arbitrary-text')).toBe(false);
    });

    it('blocks keys not in the allowlist', () => {
      expect(isAllowedRawKey('C-x')).toBe(false);
      expect(isAllowedRawKey('C-q')).toBe(false);
      expect(isAllowedRawKey('a')).toBe(false);
      expect(isAllowedRawKey('hello')).toBe(false);
    });
  });

  describe('isValidSessionName', () => {
    it('accepts valid session names', () => {
      expect(isValidSessionName('my-session')).toBe(true);
      expect(isValidSessionName('wc-auth-refactor')).toBe(true);
      expect(isValidSessionName('agent_1')).toBe(true);
      expect(isValidSessionName('test.session')).toBe(true);
      expect(isValidSessionName('ABC123')).toBe(true);
    });

    it('rejects names with special characters', () => {
      expect(isValidSessionName("'; rm -rf /")).toBe(false);
      expect(isValidSessionName('session name')).toBe(false);
      expect(isValidSessionName('a;b')).toBe(false);
      expect(isValidSessionName('a$(cmd)')).toBe(false);
      expect(isValidSessionName('a`cmd`')).toBe(false);
      expect(isValidSessionName("a'b")).toBe(false);
      expect(isValidSessionName('a"b')).toBe(false);
      expect(isValidSessionName('a\nb')).toBe(false);
    });

    it('rejects empty or overly long names', () => {
      expect(isValidSessionName('')).toBe(false);
      expect(isValidSessionName('a'.repeat(257))).toBe(false);
    });
  });

  describe('execFileSync usage (no shell)', () => {
    it('calls execFileSync with array args, not shell strings', async () => {
      // Import after mock is set up
      const tmuxModule = await import('./tmux.js');

      // Attempt to use a session name that would be dangerous in a shell
      try {
        tmuxModule.hasSession("test'; rm -rf /; echo '");
      } catch {
        // Expected to fail since mock returns empty string
      }

      // Verify execFileSync was called with array args (not a shell string)
      const calls = vi.mocked(child_process.execFileSync).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const lastCall = calls[calls.length - 1];
      // First arg should be 'tmux' (the binary)
      expect(lastCall[0]).toBe('tmux');
      // Second arg should be an array (not a concatenated string)
      expect(Array.isArray(lastCall[1])).toBe(true);
      // The dangerous session name should be passed as a single array element, not interpolated
      const args = lastCall[1] as string[];
      const sessionArg = args.find(a => a.includes("rm -rf"));
      expect(sessionArg).toBe("test'; rm -rf /; echo '");
      // The key point: it's a single argument, not parsed as shell code
    });
  });
});

describe('sendLiteralText', () => {
  it('passes -- before a chunk that starts with - so tmux does not treat it as a flag', () => {
    const session = 'wc-grok';
    const chunk = '-01M0ABCDEFGH.sock';
    sendLiteralText(session, chunk);

    // tmuxExec is mocked via execFileSync; assert the exact send-keys argv
    const calls = vi.mocked(child_process.execFileSync).mock.calls;
    const literalCall = calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('-l'),
    );
    expect(literalCall).toBeDefined();
    expect(literalCall![1]).toEqual(['send-keys', '-t', session, '-l', '--', chunk]);
  });
});

describe('sendTextAndEnter (bracketed paste + confirmed Enter)', () => {
  it('pastes the whole text as one buffer, sends Enter after ~1 s, and re-sends Enter when the input line still holds it', async () => {
    vi.useFakeTimers();
    try {
      const { sendTextAndEnter } = await import('./tmux.js');
      const session = 'wc-claude1';
      const text = '[Message from @codex1] please review /home/wave/inbox/spec.md and reply with VERDICT';
      const calls = vi.mocked(child_process.execFileSync).mock.calls;
      // first confirm capture: text still in the box; second time (if any) it is gone
      let captures = 0;
      vi.mocked(child_process.execFileSync).mockImplementation((_cmd, args) => {
        const a = args as string[];
        if (a[0] === 'capture-pane') { captures += 1; return captures === 1 ? `older line\n❯ ${text.slice(0, 60)}\n  ⏵⏵ bypass permissions on` : 'older line\n❯ \n  ⏵⏵ bypass permissions on'; }
        return '';
      });
      sendTextAndEnter(session, text);
      const argLists = () => calls.map((c) => c[1] as string[]);
      expect(argLists()).toContainEqual(['send-keys', '-t', session, 'C-u']);
      expect(argLists().some((a) => a[0] === 'load-buffer' && a.includes('-'))).toBe(true);
      const loadCall = calls.find((c) => (c[1] as string[])[0] === 'load-buffer')!;
      expect((loadCall[2] as { input?: string }).input).toBe(text);
      expect(argLists().some((a) => a[0] === 'paste-buffer' && a.includes('-p') && a.includes('-t') && a.includes(session))).toBe(true);
      expect(argLists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(0); // not yet
      await vi.advanceTimersByTimeAsync(1000);
      expect(argLists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(900);
      expect(argLists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(2); // swallowed → once more
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not press Enter twice when the first one was accepted; type mode keeps chunked keystrokes', async () => {
    vi.useFakeTimers();
    try {
      const { sendTextAndEnter, paneInputHolds } = await import('./tmux.js');
      vi.mocked(child_process.execFileSync).mockClear();
      vi.mocked(child_process.execFileSync).mockImplementation((_cmd, args) => ((args as string[])[0] === 'capture-pane' ? '> my prompt echoed above\n❯ \n  ⏵⏵ bypass' : ''));
      sendTextAndEnter('wc-claude1', 'my prompt text here');
      await vi.advanceTimersByTimeAsync(2000);
      const enters = vi.mocked(child_process.execFileSync).mock.calls.filter((c) => (c[1] as string[])[0] === 'send-keys' && (c[1] as string[]).includes('C-m'));
      expect(enters).toHaveLength(1);

      vi.mocked(child_process.execFileSync).mockClear();
      sendTextAndEnter('wc-shell', 'env X=1 claude --continue', { mode: 'type' });
      const lists = vi.mocked(child_process.execFileSync).mock.calls.map((c) => c[1] as string[]);
      expect(lists.some((a) => a[0] === 'send-keys' && a.includes('-l'))).toBe(true);
      expect(lists.some((a) => a[0] === 'load-buffer')).toBe(false);
      expect(lists.filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(1);

      expect(paneInputHolds('❯ [Message from @codex1] please review', '[Message from @codex1] please review the spec')).toBe(true);
      expect(paneInputHolds('> [Message from @codex1] please review\n❯ ', '[Message from @codex1] please review the spec')).toBe(false);
      expect(paneInputHolds('› Ask Codex to do anything', 'hello there world')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
