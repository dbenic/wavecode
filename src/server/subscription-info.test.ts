import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSubscriptionCache, runtimeDefaultsFor, subscriptionFor } from './subscription-info.js';
import type { WaveConfig } from './config.js';

let root: string;

function cfg(): WaveConfig {
  return {
    profiles_root: path.join(root, 'profiles'),
    profiles: { denis: {}, ana: {} },
    runtimes: {
      'claude-code': { command: 'claude', idle_pattern: '$', env: { CLAUDE_CONFIG_DIR: '{profile_dir}/claude' } },
      codex: { command: 'codex', idle_pattern: '>', env: { CODEX_HOME: '{profile_dir}/codex' } },
      grok: { command: 'grok', idle_pattern: '>', env: { HOME: '{profile_dir}/grok-home' } },
    },
  } as unknown as WaveConfig;
}

function write(rel: string, json: unknown): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
}

function jwt(claims: Record<string, unknown>): string {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  return `${b64('{"alg":"none"}')}.${b64(JSON.stringify(claims))}.sig`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sub-'));
  clearSubscriptionCache();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('subscriptionFor', () => {
  it('claude-code on a profile: email from .claude.json, plan from .credentials.json, nothing else', () => {
    write('profiles/denis/claude/.claude.json', { oauthAccount: { emailAddress: 'denis@example.com', organizationName: 'Spark' }, numStartups: 3 });
    write('profiles/denis/claude/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-SECRET', refreshToken: 'SECRET', subscriptionType: 'max' } });
    const info = subscriptionFor('claude-code', 'denis', cfg());
    expect(info).toEqual({ account: 'denis@example.com', plan: 'Claude Max' });
    expect(JSON.stringify(info)).not.toContain('SECRET');
  });

  it('codex on a profile: email and plan from the id_token claims; the token itself is not returned', () => {
    const token = jwt({ email: 'ana@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct_x' } });
    write('profiles/ana/codex/auth.json', { tokens: { id_token: token, access_token: 'SECRET-A', refresh_token: 'SECRET-R' } });
    expect(subscriptionFor('codex', 'ana', cfg())).toEqual({ account: 'ana@example.com', plan: 'ChatGPT Plus' });
  });

  it('codex logged in with an API key reports that as the plan', () => {
    write('profiles/ana/codex/auth.json', { OPENAI_API_KEY: 'sk-SECRET' });
    expect(subscriptionFor('codex', 'ana', cfg())).toEqual({ account: null, plan: 'OpenAI API key' });
  });

  it('grok: obvious fields from user-settings.json', () => {
    write('profiles/denis/grok-home/.grok/user-settings.json', { user: { email: 'd@x.ai' }, plan: 'SuperGrok' });
    expect(subscriptionFor('grok', 'denis', cfg())).toEqual({ account: 'd@x.ai', plan: 'Grok SuperGrok' });
  });

  it('unknown plan keys fall back to a vendor-prefixed raw label', () => {
    write('profiles/denis/claude/.credentials.json', { claudeAiOauth: { subscriptionType: 'founders' } });
    expect(subscriptionFor('claude-code', 'denis', cfg()).plan).toBe('Claude founders');
  });

  it('missing, malformed or oversized files yield nulls instead of throwing', () => {
    expect(subscriptionFor('claude-code', 'denis', cfg())).toEqual({ account: null, plan: null });
    fs.mkdirSync(path.join(root, 'profiles/ana/codex'), { recursive: true });
    fs.writeFileSync(path.join(root, 'profiles/ana/codex/auth.json'), '{not json');
    expect(subscriptionFor('codex', 'ana', cfg())).toEqual({ account: null, plan: null });
    fs.writeFileSync(path.join(root, 'profiles/ana/codex/auth.json'), JSON.stringify({ tokens: { id_token: 'x'.repeat(2 * 1024 * 1024) } }));
    expect(subscriptionFor('codex', 'ana', cfg())).toEqual({ account: null, plan: null });
    expect(subscriptionFor('aider', 'denis', cfg())).toEqual({ account: null, plan: null });
    expect(subscriptionFor('claude-code', 'nobody', cfg())).toEqual({ account: null, plan: null });
  });

  it('re-reads when the file changes (cache keyed by mtime)', () => {
    const file = 'profiles/denis/claude/.credentials.json';
    write(file, { claudeAiOauth: { subscriptionType: 'pro' } });
    expect(subscriptionFor('claude-code', 'denis', cfg()).plan).toBe('Claude Pro');
    write(file, { claudeAiOauth: { subscriptionType: 'max' } });
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, file), future, future);
    expect(subscriptionFor('claude-code', 'denis', cfg()).plan).toBe('Claude Max');
  });
});

describe('runtimeDefaultsFor', () => {
  it('codex: model and reasoning effort from the profile\'s config.toml (top level only)', () => {
    const f = path.join(root, 'profiles/ana/codex/config.toml');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '# codex\nmodel = "gpt-5.3-codex"\nmodel_reasoning_effort = "high"\n\n[projects."/x"]\nmodel = "other"\ntrust_level = "trusted"\n');
    expect(runtimeDefaultsFor('codex', 'ana', cfg())).toEqual({ model: 'gpt-5.3-codex', effort: 'high' });
  });

  it('claude-code: model/effort from settings.json; nothing configured → nulls', () => {
    write('profiles/denis/claude/settings.json', { model: 'opus', effortLevel: 'high', permissions: { allow: ['Bash'] } });
    expect(runtimeDefaultsFor('claude-code', 'denis', cfg())).toEqual({ model: 'opus', effort: 'high' });
    write('profiles/ana/claude/settings.json', { permissions: {} });
    expect(runtimeDefaultsFor('claude-code', 'ana', cfg())).toEqual({ model: null, effort: null });
    expect(runtimeDefaultsFor('claude-code', 'nobody', cfg())).toEqual({ model: null, effort: null });
  });

  it('grok: model from user-settings.json', () => {
    write('profiles/denis/grok-home/.grok/user-settings.json', { model: 'grok-4.6', user: { email: 'd@x.ai' } });
    expect(runtimeDefaultsFor('grok', 'denis', cfg())).toEqual({ model: 'grok-4.6', effort: null });
  });
});
