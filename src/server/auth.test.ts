import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';
import { createAuthMiddleware, parseForwardedFor, resolveClientIp, type NodeAppEnv } from './auth.js';
import type { WaveConfig } from './config.js';

function makeConfig(auth: Partial<WaveConfig['auth']>): WaveConfig {
  return {
    server: { port: 3777, host: '0.0.0.0' },
    paths: {
      projects_root: '/tmp/wavecode/projects',
      worktrees_root: '/tmp/wavecode/worktrees',
      transcripts_root: '/tmp/wavecode/transcripts',
      teams_root: '/tmp/wavecode/teams',
      guides_root: '/tmp/wavecode/guides',
      templates_root: '/tmp/wavecode/templates',
    },
    autonomy: { auto_dispatch: true, auto_restart: true, hang_timeout_min: 10, max_task_retries: 2, verify_completion: false },
    sandbox: { disable_git_push: true, restrict_network: true },
    runtimes: {},
    auth: {
      method: 'tailscale',
      fallback_token: null,
      trusted_proxies: [],
      ...auth,
    },
    notifications: { web_push: false, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null },
    artifacts: { storage: '/tmp/wavecode/artifacts', retention_days: 30 },
    review: { auto_review: false, default_reviewer: 'aider', self_review: true, max_fix_loops: 2 },
    llm: {
      provider: 'anthropic',
      api_key: null,
      anthropic_api_key: null,
      openai_api_key: null,
      gemini_api_key: null,
      perplexity_api_key: null,
      xai_api_key: null,
      base_url: null,
      model: 'claude-sonnet-4-20250514',
    },
  };
}

function makeApp(config: WaveConfig) {
  const app = new Hono<NodeAppEnv>();
  app.use('/api/*', createAuthMiddleware(() => config));
  app.get('/api/test', (c) => c.json({ ok: true }));
  return app;
}

describe('auth.ts', () => {
  it('parses forwarded chains into normalized IPs', () => {
    expect(parseForwardedFor(' 203.0.113.10, 100.64.0.1 ')).toEqual(['203.0.113.10', '100.64.0.1']);
    expect(parseForwardedFor(undefined)).toEqual([]);
  });

  it('ignores spoofed forwarded headers from untrusted clients', () => {
    const ip = resolveClientIp(
      { incoming: { socket: { remoteAddress: '203.0.113.10' } } },
      new Headers({
        'X-Forwarded-For': '100.64.0.20',
        'X-Real-IP': '100.64.0.21',
      }),
      [],
    );

    expect(ip).toBe('203.0.113.10');
  });

  it('accepts forwarded headers only from trusted proxies', () => {
    const ip = resolveClientIp(
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
      new Headers({
        'X-Forwarded-For': '100.64.0.20, 127.0.0.1',
      }),
      ['loopback'],
    );

    expect(ip).toBe('100.64.0.20');
  });

  it('rejects spoofed private-ip headers when tailscale auth is enabled', async () => {
    const app = makeApp(makeConfig({ method: 'tailscale', trusted_proxies: [] }));

    const response = await app.fetch(
      new Request('http://localhost/api/test', {
        headers: {
          'X-Forwarded-For': '100.64.0.99',
        },
      }),
      {
        incoming: { socket: { remoteAddress: '203.0.113.10' } },
      },
    );

    expect(response.status).toBe(401);
  });

  it('rejects requests forwarded by an untrusted loopback proxy', async () => {
    const app = makeApp(makeConfig({ method: 'tailscale', trusted_proxies: [] }));

    const response = await app.fetch(
      new Request('http://localhost/api/test', {
        headers: {
          'X-Forwarded-For': '203.0.113.44',
          'X-Real-IP': '203.0.113.44',
        },
      }),
      {
        incoming: { socket: { remoteAddress: '127.0.0.1' } },
      },
    );

    expect(response.status).toBe(401);
  });

  it('rejects requests forwarded by an untrusted private proxy', async () => {
    const app = makeApp(makeConfig({ method: 'tailscale', trusted_proxies: [] }));

    const response = await app.fetch(
      new Request('http://localhost/api/test', {
        headers: {
          'X-Forwarded-For': '203.0.113.44',
        },
      }),
      {
        incoming: { socket: { remoteAddress: '172.18.0.2' } },
      },
    );

    expect(response.status).toBe(401);
  });

  it('allows tailscale requests forwarded by a trusted proxy', async () => {
    const app = makeApp(makeConfig({
      method: 'tailscale',
      trusted_proxies: ['loopback'],
    }));

    const response = await app.fetch(
      new Request('http://localhost/api/test', {
        headers: {
          'X-Forwarded-For': '100.64.0.99',
        },
      }),
      {
        incoming: { socket: { remoteAddress: '127.0.0.1' } },
      },
    );

    expect(response.status).toBe(200);
  });

  it('allows fallback token auth from public IPs', async () => {
    const app = makeApp(makeConfig({
      method: 'tailscale',
      fallback_token: 'test-secret-token',
    }));

    const response = await app.fetch(
      new Request('http://localhost/api/test', {
        headers: {
          Authorization: 'Bearer test-secret-token',
        },
      }),
      {
        incoming: { socket: { remoteAddress: '203.0.113.10' } },
      },
    );

    expect(response.status).toBe(200);
  });

  it('requires a valid token in token-auth mode', async () => {
    const app = makeApp(makeConfig({
      method: 'token',
      fallback_token: 'expected-token',
    }));

    const denied = await app.fetch(
      new Request('http://localhost/api/test'),
      {
        incoming: { socket: { remoteAddress: '127.0.0.1' } },
      },
    );
    expect(denied.status).toBe(401);

    const allowed = await app.fetch(
      new Request('http://localhost/api/test', {
        headers: {
          Authorization: 'Bearer expected-token',
        },
      }),
      {
        incoming: { socket: { remoteAddress: '203.0.113.10' } },
      },
    );
    expect(allowed.status).toBe(200);
  });
});
