import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeAppEnv } from '../auth.js';
import type { WaveConfig } from '../config.js';

vi.mock('../config.js', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
  getProviderStatus: vi.fn(),
}));

vi.mock('../event-bus.js', () => ({
  emit: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('../llm-provider.js', () => ({
  getResolvedLlmConfig: vi.fn(),
  isLlmConfigured: vi.fn(),
  maskLlmApiKey: vi.fn((value: string | null) => (value ? `••••${value.slice(-8)}` : null)),
}));

vi.mock('../prompt-enhancer.js', () => ({
  isAvailable: vi.fn(() => true),
  enhancePrompt: vi.fn(),
}));

vi.mock('../session-manager.js', () => ({
  get: vi.fn(),
  capturePane: vi.fn(),
  stopAll: vi.fn(),
}));

vi.mock('../output-watcher.js', () => ({
  stopWatching: vi.fn(),
}));

vi.mock('../db.js', () => ({
  listEvents: vi.fn(() => []),
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh'],
  isEffortLevel: (v: unknown) => ['low', 'medium', 'high', 'xhigh'].includes(v as string),
}));

vi.mock('../logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('system routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns masked settings and public auth status', async () => {
    const config = await import('../config.js');
    const llm = await import('../llm-provider.js');

    vi.mocked(config.getConfig).mockReturnValue(makeConfig({
      auth: {
        method: 'token',
        fallback_token: 'fallback-secret',
      },
      llm: {
        provider: 'anthropic',
        api_key: null,
        anthropic_api_key: 'sk-ant-12345678',
      },
    }));
    vi.mocked(llm.getResolvedLlmConfig).mockReturnValue({
      provider: 'anthropic',
      apiKey: 'sk-ant-12345678',
      baseUrl: null,
      model: 'claude-sonnet-4-20250514',
    });
    vi.mocked(llm.isLlmConfigured).mockReturnValue(true);

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/settings'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      auth: {
        method: 'token',
        tokenConfigured: true,
      },
      llm: expect.objectContaining({
        provider: 'anthropic',
        api_key: '••••12345678',
        anthropic_api_key: '••••12345678',
        has_key: true,
        configured: true,
      }),
      runtimes: ['codex', 'claude-code'],
    }));
  });

  it('preserves masked secrets when updating settings', async () => {
    const config = await import('../config.js');

    vi.mocked(config.getConfig).mockReturnValue(makeConfig({
      llm: {
        provider: 'anthropic',
        api_key: null,
        anthropic_api_key: 'sk-ant-current',
        openai_api_key: 'sk-openai-current',
      },
    }));

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        llm: {
          provider: 'openai-compatible',
          anthropic_api_key: '••••current',
          openai_api_key: ' sk-openai-next ',
          base_url: ' http://127.0.0.1:11434/v1 ',
          model: ' gemma4 ',
        },
      }),
    }));

    expect(response.status).toBe(200);
    expect(config.updateConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'openai-compatible',
        anthropic_api_key: 'sk-ant-current',
        openai_api_key: 'sk-openai-next',
        base_url: 'http://127.0.0.1:11434/v1',
        model: 'gemma4',
      },
    });
  });

  it('updates the primary LLM API key without overwriting research-provider keys', async () => {
    const config = await import('../config.js');

    vi.mocked(config.getConfig).mockReturnValue(makeConfig({
      llm: {
        provider: 'anthropic',
        api_key: null,
        anthropic_api_key: 'sk-ant-existing',
        openai_api_key: 'sk-openai-research',
      },
    }));

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/settings/api-key', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: ' sk-openai-main ',
        provider: 'openai-compatible',
      }),
    }));

    expect(response.status).toBe(200);
    expect(config.updateConfig).toHaveBeenCalledWith({
      llm: expect.objectContaining({
        provider: 'openai-compatible',
        api_key: 'sk-openai-main',
        anthropic_api_key: 'sk-ant-existing',
        openai_api_key: 'sk-openai-research',
      }),
    });
  });

  it('returns the configured research provider availability flags', async () => {
    const config = await import('../config.js');
    vi.mocked(config.getProviderStatus).mockReturnValue({
      anthropic: true,
      openai: false,
      gemini: true,
      perplexity: false,
      xai: false,
    });

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/providers'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      anthropic: true,
      openai: false,
      gemini: true,
      perplexity: false,
      xai: false,
    });
  });

  it('streams SSE payloads and prefers the Last-Event-ID header for replay', async () => {
    const events = await import('../event-bus.js');

    vi.mocked(events.subscribe).mockImplementation((writer, lastEventId) => {
      expect(lastEventId).toBe(7);
      queueMicrotask(() => {
        writer.write('id: 9\nevent: task.completed\ndata: {"id":9,"type":"task.completed"}\n\n');
        setTimeout(() => writer.close(), 5);
      });
    });

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/events?lastEventId=2', {
      headers: {
        'Last-Event-ID': '7',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await expect(response.text()).resolves.toContain('event: task.completed');
    expect(events.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        write: expect.any(Function),
        close: expect.any(Function),
      }),
      7,
    );
  });

  it('uses the lastEventId query parameter when no replay header is present', async () => {
    const events = await import('../event-bus.js');

    vi.mocked(events.subscribe).mockImplementation((writer, lastEventId) => {
      expect(lastEventId).toBe(42);
      queueMicrotask(() => {
        writer.close();
      });
    });

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/events?lastEventId=42'));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
    expect(events.subscribe).toHaveBeenCalledWith(expect.any(Object), 42);
  });
});

async function createSystemApp() {
  const { registerSystemRoutes } = await import('./system.js');
  const app = new Hono<NodeAppEnv>();
  registerSystemRoutes(app);
  return app;
}

describe('events log (long-poll feedback channel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function makeEvent(id: number, type: string, payload: Record<string, unknown> | null = null) {
    return {
      id,
      type,
      entity_type: 'run',
      entity_id: `r${id}`,
      payload_json: payload ? JSON.stringify(payload) : null,
      created_at: '2026-08-16 10:00:00',
    };
  }

  it('returns events immediately with parsed payloads and last_id', async () => {
    const db = await import('../db.js');
    vi.mocked(db.listEvents).mockReturnValue([
      makeEvent(5, 'run.finished', { exit_code: 0 }),
      makeEvent(6, 'review.ai_completed', { verdict: 'pass' }),
    ]);

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/events/log?since=4'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.last_id).toBe(6);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toEqual(
      expect.objectContaining({ id: 5, type: 'run.finished', payload: { exit_code: 0 } }),
    );
    expect(db.listEvents).toHaveBeenCalledWith({ since_id: 4, limit: 100 });
  });

  it('filters by type with prefix wildcards but still advances last_id', async () => {
    const db = await import('../db.js');
    vi.mocked(db.listEvents).mockReturnValue([
      makeEvent(7, 'heartbeat'),
      makeEvent(8, 'review.promoted'),
      makeEvent(9, 'agent.output_updated'),
    ]);

    const app = await createSystemApp();
    const response = await app.fetch(
      new Request('http://localhost/api/events/log?types=review.*,message.created'),
    );

    const body = await response.json();
    expect(body.events.map((e: { id: number }) => e.id)).toEqual([8]);
    expect(body.last_id).toBe(9);
  });

  it('long-polls until an event arrives', async () => {
    const db = await import('../db.js');
    let calls = 0;
    vi.mocked(db.listEvents).mockImplementation(() => {
      calls++;
      return calls >= 2 ? [makeEvent(10, 'task.completed')] : [];
    });

    const app = await createSystemApp();
    const started = Date.now();
    const response = await app.fetch(
      new Request('http://localhost/api/events/log?wait_ms=5000'),
    );
    const elapsed = Date.now() - started;

    const body = await response.json();
    expect(body.events).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(5000); // returned as soon as the event appeared
  });

  it('returns empty after the wait expires', async () => {
    const db = await import('../db.js');
    vi.mocked(db.listEvents).mockImplementation(() => []);

    const app = await createSystemApp();
    const response = await app.fetch(
      new Request('http://localhost/api/events/log?since=3&wait_ms=100'),
    );
    const body = await response.json();
    expect(body.events).toEqual([]);
    expect(body.last_id).toBe(3);
  });
});

describe('system stop-all', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('kills agents, disables auto-dispatch, and reports the summary', async () => {
    const config = await import('../config.js');
    const sessionManager = await import('../session-manager.js');
    const outputWatcher = await import('../output-watcher.js');
    const events = await import('../event-bus.js');

    const cfg = makeConfig();
    vi.mocked(config.getConfig).mockReturnValue(cfg);
    vi.mocked(sessionManager.stopAll).mockReturnValue({
      killed: ['agent-1', 'agent-2'],
      interrupted: ['agent-3'],
      errors: [],
    });

    const app = await createSystemApp();
    const response = await app.fetch(new Request('http://localhost/api/system/stop-all', {
      method: 'POST',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        killed: ['agent-1', 'agent-2'],
        interrupted: ['agent-3'],
        auto_dispatch_disabled: true,
      }),
    );

    expect(outputWatcher.stopWatching).toHaveBeenCalledWith('agent-1');
    expect(outputWatcher.stopWatching).toHaveBeenCalledWith('agent-2');
    expect(config.updateConfig).toHaveBeenCalledWith({
      autonomy: expect.objectContaining({ auto_dispatch: false }),
    });
    expect(events.emit).toHaveBeenCalledWith(
      'system.stop_all',
      'system',
      'stop-all',
      expect.objectContaining({ killed: 2, interrupted: 1 }),
    );
  });
})

function makeConfig(overrides: Partial<WaveConfig> & {
  auth?: Partial<WaveConfig['auth']>;
  llm?: Partial<WaveConfig['llm']>;
} = {}): WaveConfig {
  return {
    server: { port: 3777, host: '0.0.0.0' },
    paths: {
      projects_root: '/tmp/projects',
      worktrees_root: '/tmp/worktrees',
      transcripts_root: '/tmp/transcripts',
      teams_root: '/tmp/teams',
      guides_root: '/tmp/guides',
      templates_root: '/tmp/templates',
    },
    autonomy: {
      auto_dispatch: true,
      auto_restart: true,
      hang_timeout_min: 10,
      max_task_retries: 2,
      verify_completion: false,
    },
    sandbox: {
      disable_git_push: true,
      restrict_network: true,
    },
    runtimes: {
      codex: {
        command: 'codex --full-auto',
        idle_pattern: '^>\\s*$',
      },
      'claude-code': {
        command: 'claude --permission-mode bypassPermissions',
        idle_pattern: '\\$\\s*$',
      },
    },
    auth: {
      method: 'tailscale',
      fallback_token: null,
      trusted_proxies: [],
      ...overrides.auth,
    },
    notifications: {
      web_push: false,
      ntfy_topic: null,
      telegram_bot_token: null,
      telegram_chat_id: null,
    },
    artifacts: {
      storage: '/tmp/artifacts',
      retention_days: 30,
    },
    review: {
      auto_review: false,
      default_reviewer: 'aider',
      self_review: true,
      max_fix_loops: 2,
    },
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
      ...overrides.llm,
    },
    ...overrides,
  };
}
