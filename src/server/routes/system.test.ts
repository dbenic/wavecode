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
