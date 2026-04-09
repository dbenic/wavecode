/**
 * Phase 3 Tests — output-watcher.ts (status detection, tick guard)
 */

import { describe, it, expect } from 'vitest';
import { detectPermissionMode, detectStatus } from './output-watcher.js';

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
