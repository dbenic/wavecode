/**
 * Phase 1 Security Tests — tmux.ts (shell injection prevention)
 *
 * These tests verify that:
 * 1. All tmux calls use execFile (no shell injection, and they do not block the loop)
 * 2. Raw key allowlist blocks arbitrary input
 * 3. Session name validation works correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as child_process from 'node:child_process';
import logger from './logger.js';
import { bindSessionSocket, isAllowedRawKey, isValidSessionName, isValidSocketName, resetTmuxSocketsForTest, sendLiteralText } from './tmux.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function complete(stdout: string, opts: unknown, cb?: ExecCb) {
  const callback = typeof opts === 'function' ? opts as ExecCb : cb;
  callback?.(null, stdout, '');
  return { stdin: { end: () => undefined } };
}

function scripted(stdoutFor: (args: string[]) => string) {
  vi.mocked(child_process.execFile).mockImplementation(((...args: unknown[]) => {
    return complete(stdoutFor(args[1] as string[]), args[2], args[3] as ExecCb | undefined);
  }) as never);
}

// Mock execFile to inspect calls without needing real tmux. The callback
// runs on the loop, the way the server calls tmux.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: unknown[]) => complete('', args[2], args[3] as ExecCb | undefined)),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('tmux.ts — shell injection prevention', () => {
  beforeEach(() => {
    resetTmuxSocketsForTest();
    vi.mocked(child_process.execFile).mockReset();
    vi.mocked(child_process.execFile).mockImplementation(((...args: unknown[]) => complete('', args[2], args[3] as ExecCb | undefined)) as never);
    vi.mocked(logger.error).mockClear();
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

  describe('execFile usage (no shell)', () => {
    it('calls execFile with array args, not shell strings', async () => {
      const tmuxModule = await import('./tmux.js');

      await tmuxModule.hasSession("test'; rm -rf /; echo '");

      const calls = vi.mocked(child_process.execFile).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const lastCall = calls[calls.length - 1];
      // First arg should be 'tmux' (the binary)
      expect(lastCall[0]).toBe('tmux');
      // Second arg should be an array (not a concatenated string)
      expect(Array.isArray(lastCall[1])).toBe(true);
      // The dangerous session name should be passed as a single array element, not interpolated
      const args = lastCall[1] as string[];
      const sessionArg = args.find(a => a.includes("rm -rf"));
      expect(sessionArg).toBe("=test'; rm -rf /; echo '"); // exact-match target, still one argument
      // The key point: it's a single argument, not parsed as shell code
    });
  });
});

describe('exact session targets', () => {
  it('prefixes -t targets with = so tmux never prefix-matches a sibling session (wc-fable-analyst vs wc-fable-analyst2)', async () => {
    const { exactTarget, hasSession, capturePane } = await import('./tmux.js');
    expect(exactTarget('wc-fable-analyst')).toBe('=wc-fable-analyst');
    expect(exactTarget('wc-x:0.0')).toBe('=wc-x:0.0');
    expect(exactTarget('=already')).toBe('=already');
    expect(exactTarget('%12')).toBe('%12');
    vi.mocked(child_process.execFile).mockClear();
    await hasSession('wc-fable-analyst');
    await capturePane('wc-fable-analyst', 5);
    const lists = vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]);
    expect(lists[0]).toEqual(['has-session', '-t', '=wc-fable-analyst']);
    expect(lists[1].slice(0, 3)).toEqual(['capture-pane', '-t', '=wc-fable-analyst']);
  });
});

describe('sendLiteralText', () => {
  it('passes -- before a chunk that starts with - so tmux does not treat it as a flag', async () => {
    const session = 'wc-grok';
    const chunk = '-01M0ABCDEFGH.sock';
    await sendLiteralText(session, chunk);

    // tmuxExec is mocked via execFile; assert the exact send-keys argv
    const calls = vi.mocked(child_process.execFile).mock.calls;
    const literalCall = calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('-l'),
    );
    expect(literalCall).toBeDefined();
    expect(literalCall![1]).toEqual(['send-keys', '-t', `=${session}`, '-l', '--', chunk]);
  });
});

describe('sendTextAndEnter (bracketed paste + confirmed Enter)', () => {
  beforeEach(() => {
    vi.mocked(child_process.execFile).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it('pastes the whole text as one buffer, sends Enter after ~1 s, and re-sends Enter when the input line still holds it', async () => {
    vi.useFakeTimers();
    try {
      const { sendTextAndEnter } = await import('./tmux.js');
      const session = 'wc-claude1';
      const text = '[Message from @codex1] please review /home/wave/inbox/spec.md and reply with VERDICT';
      const calls = vi.mocked(child_process.execFile).mock.calls;
      // first confirm capture: text still in the box; second time (if any) it is gone
      let captures = 0;
      scripted((a) => {
        if (a[0] === 'capture-pane') { captures += 1; return captures === 1 ? `older line\n❯ ${text.slice(0, 60)}\n  ⏵⏵ bypass permissions on` : 'older line\n❯ \n  ⏵⏵ bypass permissions on'; }
        return '';
      });
      const pending = sendTextAndEnter(session, text);
      await vi.advanceTimersByTimeAsync(0);
      const argLists = () => calls.map((c) => c[1] as string[]);
      expect(argLists()).toContainEqual(['send-keys', '-t', `=${session}`, 'C-u']);
      expect(argLists().some((a) => a[0] === 'load-buffer' && a.includes('-'))).toBe(true);
      const loadCall = calls.find((c) => (c[1] as string[])[0] === 'load-buffer')!;
      expect((loadCall[2] as { input?: string }).input).toBe(text);
      expect(argLists().some((a) => a[0] === 'paste-buffer' && a.includes('-p') && a.includes('-t') && a.includes(`=${session}`))).toBe(true);
      expect(argLists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(0); // not yet
      await vi.advanceTimersByTimeAsync(1000);
      expect(argLists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(1);
      const firstEnter = argLists().find((a) => a[0] === 'send-keys' && a.includes('C-m'))!;
      expect(firstEnter).toEqual(['send-keys', '-t', `=${session}`, 'C-m']); // Enter is not in the paste argv
      await vi.advanceTimersByTimeAsync(900);
      expect(argLists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(2); // swallowed → retry
      await vi.advanceTimersByTimeAsync(900);
      expect(argLists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(2); // next capture is clear
      expect(logger.error).not.toHaveBeenCalled();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not press Enter twice when the first one was accepted; type mode keeps chunked keystrokes', async () => {
    vi.useFakeTimers();
    try {
      const { sendTextAndEnter, paneInputHolds } = await import('./tmux.js');
      vi.mocked(child_process.execFile).mockClear();
      scripted((a) => (a[0] === 'capture-pane' ? '> my prompt echoed above\n❯ \n  ⏵⏵ bypass' : ''));
      const pasted = sendTextAndEnter('wc-claude1', 'my prompt text here');
      await vi.advanceTimersByTimeAsync(2000);
      await pasted;
      const enters = vi.mocked(child_process.execFile).mock.calls.filter((c) => (c[1] as string[])[0] === 'send-keys' && (c[1] as string[]).includes('C-m'));
      expect(enters).toHaveLength(1);

      vi.mocked(child_process.execFile).mockClear();
      const typedSend = sendTextAndEnter('wc-shell', 'env X=1 claude --continue', { mode: 'type' });
      await vi.advanceTimersByTimeAsync(0);
      const lists = () => vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]);
      expect(lists().some((a) => a[0] === 'send-keys' && a.includes('-l'))).toBe(true);
      expect(lists().some((a) => a[0] === 'load-buffer')).toBe(false);
      expect(lists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(lists().filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(900); // confirm capture sees an empty input line
      await typedSend;
      expect(vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === 'send-keys' && a.includes('C-m'))).toHaveLength(1);

      expect(paneInputHolds('❯ [Message from @codex1] please review', '[Message from @codex1] please review the spec')).toBe(true);
      expect(paneInputHolds('> [Message from @codex1] please review\n❯ ', '[Message from @codex1] please review the spec')).toBe(false);
      expect(paneInputHolds('› Ask Codex to do anything', 'hello there world')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries Enter twice when the line stays, then logs a failure, on the agent socket', async () => {
    vi.useFakeTimers();
    try {
      const { sendTextAndEnter } = await import('./tmux.js');
      vi.mocked(child_process.execFile).mockClear();
      const session = 'wc-claude1';
      const text = 'Your lane claude1 is behind main. Run: git fetch origin && git merge origin/main';
      bindSessionSocket(session, 'countix');
      scripted((a) => (a.includes('capture-pane') ? `older line\n❯ ${text.slice(0, 48)}\n  ⏵⏵ bypass permissions on` : ''));
      const pending = sendTextAndEnter(session, text);
      await vi.advanceTimersByTimeAsync(0);
      const argLists = () => vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]);
      const enters = () => argLists().filter((a) => a.includes('send-keys') && a.includes('C-m'));
      expect(argLists().some((a) => a.includes('load-buffer'))).toBe(true);
      expect(argLists().some((a) => a.includes('paste-buffer') && a.includes('-p'))).toBe(true);
      expect(argLists().every((a) => a[0] === '-L' && a[1] === 'countix')).toBe(true);
      expect(enters()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(enters()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(900);
      expect(enters()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(900);
      expect(enters()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(900);
      expect(enters()).toHaveLength(3); // two retries, then stop
      expect(enters().every((a) => a[0] === '-L' && a[1] === 'countix' && !a.includes('-l'))).toBe(true);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ session, preview: text.slice(0, 80) }),
        expect.stringContaining('input line'),
      );
      await pending;
    } finally {
      resetTmuxSocketsForTest();
      vi.useRealTimers();
    }
  });

  it('retries a send-keys -l notification when the input line still holds it', async () => {
    vi.useFakeTimers();
    try {
      const { sendTextAndEnter } = await import('./tmux.js');
      vi.mocked(child_process.execFile).mockClear();
      const session = 'wc-claude1';
      const text = 'Your lane claude1 is behind main. Nothing else to do.';
      let captures = 0;
      scripted((a) => {
        if (a[0] === 'capture-pane') {
          captures += 1;
          return captures < 3 ? `❯ ${text}\n  ⏵⏵ bypass permissions on` : '❯ \n  ⏵⏵ bypass permissions on';
        }
        return '';
      });
      const pending = sendTextAndEnter(session, text, { mode: 'type' });
      await vi.advanceTimersByTimeAsync(0);
      const enters = () => vi.mocked(child_process.execFile).mock.calls
        .map((c) => c[1] as string[])
        .filter((a) => a[0] === 'send-keys' && a.includes('C-m'));
      const typed = vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]);
      expect(typed.some((a) => a[0] === 'send-keys' && a.includes('-l') && a.includes(text))).toBe(true);
      expect(enters()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(300);
      expect(enters()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(900);
      expect(enters()).toHaveLength(2); // still on the input line
      await vi.advanceTimersByTimeAsync(900);
      expect(enters()).toHaveLength(3); // second retry, then the next capture is clear
      await vi.advanceTimersByTimeAsync(900);
      expect(enters()).toHaveLength(3);
      expect(logger.error).not.toHaveBeenCalled();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('names each paste buffer with the session, a counter, and a random, and holds a raw key behind that paste', async () => {
    vi.useFakeTimers();
    try {
      const { sendRawKey, sendTextAndEnter } = await import('./tmux.js');
      vi.mocked(child_process.execFile).mockClear();
      scripted((a) => (a[0] === 'capture-pane' ? '❯ \n' : ''));
      const session = 'wc-claude1';
      const text = 'please review the spec now';
      const lists = () => vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]);
      const bufferNames = () => lists()
        .filter((a) => a.includes('load-buffer'))
        .map((a) => a[a.indexOf('-b') + 1]);

      const first = sendTextAndEnter(session, text);
      await vi.advanceTimersByTimeAsync(0);
      expect(bufferNames()[0]).toMatch(/^wc-wc-claude1-\d+-[a-z0-9]+$/);
      const raw = sendRawKey(session, 'Enter');
      await vi.advanceTimersByTimeAsync(0);
      expect(lists().some((a) => a[0] === 'send-keys' && a.includes('Enter'))).toBe(false);

      const second = sendTextAndEnter('wc-other', text);
      await vi.advanceTimersByTimeAsync(0);
      const names = bufferNames();
      expect(names).toHaveLength(2);
      expect(names[1]).toMatch(/^wc-wc-other-\d+-[a-z0-9]+$/);
      expect(names[0]).not.toBe(names[1]);
      expect(lists().some((a) => a[0] === 'send-keys' && a.includes('Enter') && a.includes(`=${session}`))).toBe(false);

      await vi.advanceTimersByTimeAsync(1900);
      await first;
      await raw;
      const after = lists();
      const pasteAt = after.findIndex((a) => a.includes('paste-buffer') && a.includes(`=${session}`));
      const enterAt = after.findIndex((a) => a[0] === 'send-keys' && a.includes('Enter') && a.includes(`=${session}`));
      expect(pasteAt).toBeGreaterThanOrEqual(0);
      expect(enterAt).toBeGreaterThan(pasteAt);
      await vi.advanceTimersByTimeAsync(2000);
      await second;
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds -L only for a session bound to a socket, including load-buffer', async () => {
    expect(isValidSocketName('fable')).toBe(true);
    expect(isValidSocketName('../fable')).toBe(false);
    await sendLiteralText('wc-grok', 'hi');
    const unbound = vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]);
    expect(unbound.every((args) => args[0] !== '-L')).toBe(true);
    vi.mocked(child_process.execFile).mockClear();
    bindSessionSocket('wc-grok', 'fable');
    await sendLiteralText('wc-grok', 'yo');
    const bound = vi.mocked(child_process.execFile).mock.calls.map((c) => c[1] as string[]);
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every((args) => args[0] === '-L' && args[1] === 'fable')).toBe(true);
  });
});
