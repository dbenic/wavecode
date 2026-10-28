import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('strips tokens, keys, and password values and leaves the footer alone', () => {
    expect(redactSecrets('password=hunter2')).toBe('password=[redacted]');
    expect(redactSecrets('token: sk-do-not-leak')).toBe('token: [redacted]');
    expect(redactSecrets('api_key=sk-ant-api03-supersecret')).toBe('api_key=[redacted]');
    expect(redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadxx.signaturex')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('key sk-live-not-a-real-key and ghp_1234567890abcdef')).not.toMatch(/sk-live|ghp_/);
    const sha = 'a'.repeat(40);
    expect(redactSecrets(`esc to interrupt\n${sha}`)).toBe(`esc to interrupt\n${sha}`);
    expect(redactSecrets('password=hunter2')).not.toContain('hunter2');
  });
});
