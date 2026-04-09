/**
 * Phase 3 Tests — validate.ts (input validation)
 */

import { describe, it, expect } from 'vitest';
import {
  validateAdoptBody,
  validateSendBody,
  validateSpawnBody,
  validateTaskBody,
  validateChatBody,
  validateIntParam,
} from './validate.js';

describe('validate.ts — input validation', () => {
  describe('validateAdoptBody', () => {
    it('accepts valid input', () => {
      expect(validateAdoptBody({ sessionName: 'my-session', runtime: 'claude-code' })).toBeNull();
      expect(validateAdoptBody({ sessionName: 'co-edge', runtime: 'codex', name: 'edge' })).toBeNull();
    });

    it('rejects missing sessionName', () => {
      expect(validateAdoptBody({ runtime: 'claude-code' } as any)).not.toBeNull();
    });

    it('rejects invalid session names', () => {
      expect(validateAdoptBody({ sessionName: "'; rm -rf /", runtime: 'claude-code' })).not.toBeNull();
      expect(validateAdoptBody({ sessionName: 'a b', runtime: 'claude-code' })).not.toBeNull();
    });

    it('rejects invalid name', () => {
      expect(validateAdoptBody({ sessionName: 'ok', runtime: 'claude-code', name: 'has space' })).not.toBeNull();
      expect(validateAdoptBody({ sessionName: 'ok', runtime: 'claude-code', name: '' })).not.toBeNull();
    });
  });

  describe('validateSendBody', () => {
    it('accepts valid text', () => {
      expect(validateSendBody({ text: 'hello world' })).toBeNull();
    });

    it('rejects empty text', () => {
      expect(validateSendBody({} as any)).not.toBeNull();
      expect(validateSendBody({ text: '' })).not.toBeNull();
    });

    it('rejects text exceeding max length', () => {
      expect(validateSendBody({ text: 'a'.repeat(100_001) })).not.toBeNull();
    });

    it('validates raw keys against allowlist', () => {
      expect(validateSendBody({ text: 'C-c', raw: true })).toBeNull();
      expect(validateSendBody({ text: 'Escape', raw: true })).toBeNull();
      expect(validateSendBody({ text: 'arbitrary', raw: true })).not.toBeNull();
      expect(validateSendBody({ text: "'; rm -rf /", raw: true })).not.toBeNull();
    });
  });

  describe('validateSpawnBody', () => {
    it('accepts valid spawn params', () => {
      expect(validateSpawnBody({ name: 'my-agent', runtime: 'claude-code' })).toBeNull();
    });

    it('rejects invalid names', () => {
      expect(validateSpawnBody({ name: 'has space', runtime: 'claude-code' })).not.toBeNull();
      expect(validateSpawnBody({ name: '', runtime: 'claude-code' })).not.toBeNull();
      expect(validateSpawnBody({ name: 'a'.repeat(65), runtime: 'claude-code' })).not.toBeNull();
    });
  });

  describe('validateTaskBody', () => {
    it('accepts valid task', () => {
      expect(validateTaskBody({ prompt: 'Build auth module' })).toBeNull();
      expect(validateTaskBody({ prompt: 'Test', priority: 5 })).toBeNull();
      expect(validateTaskBody({ prompt: 'Test', depends_on: ['task-1', 'task-2'] })).toBeNull();
    });

    it('rejects empty prompt', () => {
      expect(validateTaskBody({} as any)).not.toBeNull();
    });

    it('rejects non-finite priority', () => {
      expect(validateTaskBody({ prompt: 'ok', priority: NaN })).not.toBeNull();
      expect(validateTaskBody({ prompt: 'ok', priority: Infinity })).not.toBeNull();
    });

    it('rejects invalid depends_on payloads', () => {
      expect(validateTaskBody({ prompt: 'ok', depends_on: ['task-1', ''] })).not.toBeNull();
      expect(validateTaskBody({ prompt: 'ok', depends_on: 'task-1' as any })).not.toBeNull();
    });
  });

  describe('validateChatBody', () => {
    it('accepts valid message', () => {
      expect(validateChatBody({ message: 'hello' })).toBeNull();
    });

    it('rejects empty/whitespace message', () => {
      expect(validateChatBody({ message: '  ' })).not.toBeNull();
      expect(validateChatBody({} as any)).not.toBeNull();
    });
  });

  describe('validateIntParam', () => {
    it('returns default for undefined', () => {
      expect(validateIntParam(undefined, { default: 50 })).toBe(50);
    });

    it('parses valid integers', () => {
      expect(validateIntParam('100', { default: 50 })).toBe(100);
    });

    it('clamps to min/max', () => {
      expect(validateIntParam('0', { min: 1, max: 500, default: 50 })).toBe(1);
      expect(validateIntParam('999', { min: 1, max: 500, default: 50 })).toBe(500);
    });

    it('returns default for non-numeric', () => {
      expect(validateIntParam('abc', { default: 50 })).toBe(50);
    });
  });
});
