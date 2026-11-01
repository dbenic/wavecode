import { describe, expect, it } from 'vitest';
import { PROVIDER_KEY_VARS, providerKeysInEnv, scrubEnv, scrubPrefix } from './provider-keys.js';

describe('provider keys', () => {
  it('names the keys present, never their values', () => {
    expect(providerKeysInEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: '' })).toEqual(['ANTHROPIC_API_KEY']);
    expect(providerKeysInEnv({ HOME: '/h' })).toEqual([]);
  });

  it('scrubEnv drops every provider key and keeps the rest', () => {
    const env = { HOME: '/h', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'c', GEMINI_API_KEY: 'd', GOOGLE_API_KEY: 'e', XAI_API_KEY: 'f' };
    expect(scrubEnv(env)).toEqual({ HOME: '/h' });
    for (const v of PROVIDER_KEY_VARS) expect(v in scrubEnv(env)).toBe(false);
  });

  it('scrubPrefix is empty for a clean daemon and `env -u …` for the keys it carries', () => {
    expect(scrubPrefix({ HOME: '/h' })).toBe('');
    expect(scrubPrefix({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'c' })).toBe('env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY');
  });
});
