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
import { isAllowedRawKey, isValidSessionName } from './tmux.js';

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
