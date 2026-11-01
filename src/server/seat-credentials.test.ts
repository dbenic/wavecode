/**
 * Seat credentials (1 Nov 2026 policy): how a seat is authenticated is read from the profile's own
 * files and the pane environment; a key parks (and kills) the seat, a lost login parks it, a plan
 * under the floor parks it; nothing of a key's value leaves the module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const harness = vi.hoisted(() => ({
  quota: null as number | null,
  killed: [] as string[],
  root: '',
}));

vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('./tmux.js', () => ({
  killSession: vi.fn(async (s: string) => { harness.killed.push(s); }),
  panePid: vi.fn(async () => null),
  tmuxExecSafe: vi.fn(async () => null),
}));
vi.mock('./usage-probe.js', () => ({ quotaLeftPct: vi.fn(() => harness.quota) }));
vi.mock('./subscription-info.js', () => ({ subscriptionFor: vi.fn(() => ({ account: null, plan: 'ChatGPT Pro' })) }));
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    profiles_root: harness.root,
    profiles: { ana: {}, bob: {} },
    autonomy: { min_quota_pct: 5 },
    usage: { probe_interval_min: 15 },
    runtimes: {
      'claude-code': { command: 'claude', idle_pattern: '>', login_command: 'claude /login', env: { CLAUDE_CONFIG_DIR: '{profile_dir}/claude' }, credential_files: ['{profile_dir}/claude/.credentials.json'] },
      codex: { command: 'codex', idle_pattern: '>', login_command: 'codex login', env: { CODEX_HOME: '{profile_dir}/codex' }, credential_files: ['{profile_dir}/codex/auth.json'] },
      grok: { command: 'grok', idle_pattern: '>', login_command: 'grok', env: { HOME: '{profile_dir}/grok-home' }, credential_files: ['{profile_dir}/grok-home/.grok/auth.json'] },
      aider: { command: 'aider --yes', idle_pattern: '>' },
    },
  })),
}));
vi.mock('./profiles.js', () => ({
  resolveProfileEnv: vi.fn((runtime: string, profile: string | null) => {
    if (!profile) return { ok: true, data: {} };
    const dir = path.join(harness.root, profile);
    const env: Record<string, string> = runtime === 'claude-code' ? { CLAUDE_CONFIG_DIR: path.join(dir, 'claude') }
      : runtime === 'codex' ? { CODEX_HOME: path.join(dir, 'codex') }
        : runtime === 'grok' ? { HOME: path.join(dir, 'grok-home') } : {};
    return { ok: true, data: env };
  }),
}));

import * as db from './db.js';
import { emit } from './event-bus.js';
import { notify } from './notifications.js';
import {
  DEFAULT_MIN_QUOTA_PCT,
  defaultDeps,
  ensureAgentAuthTable,
  inspectSeatAuth,
  refreshSeatAuth,
  resetSeatAuthForTest,
  seatAuthFor,
  seatOut,
  type SeatAuthDeps,
} from './seat-credentials.js';
import type { Agent } from './db.js';

const KEY = 'sk-ant-api03-FAKE-TEST-KEY-NOT-REAL-' + 'x'.repeat(24) + '-FAKE-SUFFIX-0000AA'; // fixture only; same shape as a real key

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: over.id ?? 'a1', name: over.name ?? 'claude2', runtime: over.runtime ?? 'claude-code', tmux_session: over.tmux_session ?? 'wc-claude2',
    workspace: null, mode: over.mode ?? 'spawned', status: 'idle', model: null, effort: null, profile: over.profile ?? 'ana', created_at: '2026-11-01 00:00:00',
    ...over,
  } as Agent;
}

function write(file: string, json: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
}

function deps(pane: Record<string, string> | null): SeatAuthDeps {
  return { ...defaultDeps, paneEnv: async () => pane, now: () => new Date('2026-11-01T12:00:00Z') };
}

describe('seat credentials', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-auth-'));
    harness.root = path.join(tmp, 'profiles');
    harness.quota = null;
    harness.killed = [];
    db.initDb(path.join(tmp, 'test.db'));
    ensureAgentAuthTable();
    resetSeatAuthForTest();
    vi.mocked(emit).mockClear();
    vi.mocked(notify).mockClear();
  });
  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('inspectSeatAuth', () => {
    it('Claude: OAuth login and no key is a subscription with its plan', async () => {
      write(path.join(harness.root, 'ana/claude/.credentials.json'), { claudeAiOauth: { accessToken: 'secret', subscriptionType: 'max' } });
      const auth = await inspectSeatAuth(agent(), undefined, deps({ PATH: '/bin' }));
      expect(auth).toMatchObject({ mode: 'subscription', plan: 'Claude Max', env_key: null });
    });

    it('Claude: no credentials file is logged out', async () => {
      const auth = await inspectSeatAuth(agent(), undefined, deps(null));
      expect(auth.mode).toBe('logged-out');
    });

    it('Claude: a key the CLI rejected stays a subscription, with the variable NAME only', async () => {
      write(path.join(harness.root, 'ana/claude/.credentials.json'), { claudeAiOauth: { subscriptionType: 'team' } });
      write(path.join(harness.root, 'ana/claude/.claude.json'), { customApiKeyResponses: { approved: [], rejected: [KEY.slice(-20)] } });
      const auth = await inspectSeatAuth(agent(), undefined, deps({ ANTHROPIC_API_KEY: KEY }));
      expect(auth).toMatchObject({ mode: 'subscription', plan: 'Claude Team', env_key: 'ANTHROPIC_API_KEY' });
      expect(JSON.stringify(auth)).not.toContain(KEY.slice(0, 12));
    });

    it('Claude: a key in the pane that the CLI did not reject is an API key', async () => {
      write(path.join(harness.root, 'ana/claude/.credentials.json'), { claudeAiOauth: { subscriptionType: 'max' } });
      write(path.join(harness.root, 'ana/claude/.claude.json'), { customApiKeyResponses: { approved: [], rejected: ['something-else-entirely'] } });
      const auth = await inspectSeatAuth(agent(), undefined, deps({ ANTHROPIC_API_KEY: KEY }));
      expect(auth.mode).toBe('api-key');
    });

    it('Claude: a key in the pane with no login at all is an API key', async () => {
      const auth = await inspectSeatAuth(agent(), undefined, deps({ ANTHROPIC_API_KEY: KEY }));
      expect(auth).toMatchObject({ mode: 'api-key', env_key: 'ANTHROPIC_API_KEY' });
    });

    it('Claude: a profile that approved a key is an API key even with a login', async () => {
      write(path.join(harness.root, 'ana/claude/.credentials.json'), { claudeAiOauth: { subscriptionType: 'max' } });
      write(path.join(harness.root, 'ana/claude/.claude.json'), { customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] } });
      const auth = await inspectSeatAuth(agent(), undefined, deps(null));
      expect(auth.mode).toBe('api-key');
      expect(auth.detail).toContain('approved');
    });

    it('Codex: ChatGPT tokens are a subscription, an OpenAI key in auth.json or the pane is an API key, nothing is logged out', async () => {
      const a = agent({ runtime: 'codex', profile: 'bob', tmux_session: 'wc-codex1' });
      expect((await inspectSeatAuth(a, undefined, deps(null))).mode).toBe('logged-out');
      write(path.join(harness.root, 'bob/codex/auth.json'), { tokens: { id_token: 'x.y.z' } });
      expect(await inspectSeatAuth(a, undefined, deps(null))).toMatchObject({ mode: 'subscription', plan: 'ChatGPT Pro' });
      expect((await inspectSeatAuth(a, undefined, deps({ OPENAI_API_KEY: 'sk-live' }))).mode).toBe('api-key');
      write(path.join(harness.root, 'bob/codex/auth.json'), { OPENAI_API_KEY: 'sk-live' });
      expect((await inspectSeatAuth(a, undefined, deps(null))).mode).toBe('api-key');
    });

    it('a subscription CLI known only by credential files (grok): file present = subscription, a provider key in the pane = API key', async () => {
      const a = agent({ runtime: 'grok', profile: 'ana', tmux_session: 'wc-grok1' });
      expect((await inspectSeatAuth(a, undefined, deps(null))).mode).toBe('logged-out');
      write(path.join(harness.root, 'ana/grok-home/.grok/auth.json'), { user: { email: 'a@b' } });
      expect((await inspectSeatAuth(a, undefined, deps(null))).mode).toBe('subscription');
      expect((await inspectSeatAuth(a, undefined, deps({ XAI_API_KEY: 'xai-1' }))).mode).toBe('api-key');
    });

    it('a key-based runtime (aider) is unknown and never parked', async () => {
      const a = agent({ runtime: 'aider', profile: null, tmux_session: 'wc-aider1' });
      const auth = await inspectSeatAuth(a, undefined, deps({ OPENAI_API_KEY: 'sk-live' }));
      expect(auth.mode).toBe('unknown');
    });
  });

  describe('refreshSeatAuth', () => {
    it('stores the reading, kills a spawned seat that runs on a key once, and tells everyone', async () => {
      const a = agent();
      const auth = await refreshSeatAuth(a, deps({ ANTHROPIC_API_KEY: KEY }));
      expect(auth.mode).toBe('api-key');
      expect(seatAuthFor('a1')?.mode).toBe('api-key');
      expect(harness.killed).toEqual(['wc-claude2']);
      expect(vi.mocked(emit).mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['agent.api_key', 'agent.killed_for_key']));
      expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
      const payloads = JSON.stringify(vi.mocked(emit).mock.calls) + JSON.stringify(vi.mocked(notify).mock.calls);
      expect(payloads).not.toContain(KEY.slice(0, 16));
      // Same state again within the hour: no second kill, no second notification.
      await refreshSeatAuth(a, deps({ ANTHROPIC_API_KEY: KEY }));
      expect(harness.killed).toHaveLength(1);
      expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
    });

    it('an adopted seat on a key is parked and reported but its pane is left alone', async () => {
      await refreshSeatAuth(agent({ mode: 'adopted' }), deps({ ANTHROPIC_API_KEY: KEY }));
      expect(harness.killed).toEqual([]);
      expect(vi.mocked(emit).mock.calls.map((c) => c[0])).toContain('agent.api_key');
      expect(seatOut(agent())?.reason).toBe('key');
    });

    it('logged out → notified once; login restored → agent.auth_restored', async () => {
      const a = agent();
      await refreshSeatAuth(a, deps(null));
      expect(seatOut(a)).toMatchObject({ reason: 'login' });
      expect(vi.mocked(emit).mock.calls.map((c) => c[0])).toContain('agent.logged_out');
      expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
      write(path.join(harness.root, 'ana/claude/.credentials.json'), { claudeAiOauth: { subscriptionType: 'max' } });
      await refreshSeatAuth(a, deps(null));
      expect(seatOut(a)).toBeNull();
      expect(vi.mocked(emit).mock.calls.map((c) => c[0])).toContain('agent.auth_restored');
      expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
    });
  });

  describe('seatOut', () => {
    it('quota under the floor parks the seat; at or above it does not; never probed is fine', () => {
      write(path.join(harness.root, 'ana/claude/.credentials.json'), { claudeAiOauth: { subscriptionType: 'max' } });
      harness.quota = 4;
      expect(seatOut(agent())).toMatchObject({ reason: 'quota', detail: '4% of the plan left (floor 5%)' });
      harness.quota = 5;
      expect(seatOut(agent())).toBeNull();
      harness.quota = null;
      expect(seatOut(agent())).toBeNull();
      expect(DEFAULT_MIN_QUOTA_PCT).toBe(5);
    });

    it('a key or a lost login outranks the plan', async () => {
      harness.quota = 90;
      await refreshSeatAuth(agent(), deps(null));
      expect(seatOut(agent())?.reason).toBe('login');
    });
  });
});
