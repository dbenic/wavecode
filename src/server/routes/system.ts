import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getConfig, updateConfig, getProviderStatus, type WaveConfig } from '../config.js';
import { subscribe, unsubscribe } from '../event-bus.js';
import { getResolvedLlmConfig, isLlmConfigured, maskLlmApiKey } from '../llm-provider.js';
import * as promptEnhancer from '../prompt-enhancer.js';
import * as sessionManager from '../session-manager.js';
import logger from '../logger.js';
import { getPublicAuthStatus, type NodeAppEnv } from '../auth.js';

export function registerSystemRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/auth/status', (c) => {
    return c.json(getPublicAuthStatus(getConfig()));
  });

  app.get('/api/auth/verify', (c) => {
    return c.json({ ok: true });
  });

  app.get('/api/enhance/status', (c) => {
    return c.json({ available: promptEnhancer.isAvailable() });
  });

  app.post('/api/enhance', async (c) => {
    const body = await c.req.json<{
      prompt: string;
      agentId: string;
    }>();

    const agentResult = sessionManager.get(body.agentId);
    if (!agentResult.ok) return c.json({ error: agentResult.error }, 404);

    const agent = agentResult.data;
    const outputResult = sessionManager.capturePane(agent.tmux_session, 30);
    let lastOutput: string | undefined;
    if (outputResult.ok) {
      lastOutput = outputResult.data
        .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
        .replace(/  +/g, ' ');
    }

    const result = await promptEnhancer.enhancePrompt({
      prompt: body.prompt,
      runtime: agent.runtime,
      agentName: agent.name,
      lastOutput,
    });

    if (!result.ok) return c.json({ error: result.error }, 500);
    return c.json({ enhanced: result.data, original: body.prompt });
  });

  app.get('/api/settings', (c) => {
    const cfg = getConfig();
    const llm = getResolvedLlmConfig();
    return c.json({
      server: cfg.server,
      paths: cfg.paths,
      auth: getPublicAuthStatus(cfg),
      autonomy: cfg.autonomy,
      llm: {
        provider: llm.provider,
        api_key: maskLlmApiKey(llm.apiKey),
        has_key: !!llm.apiKey,
        configured: isLlmConfigured(),
        base_url: llm.baseUrl,
        model: llm.model,
        anthropic_api_key: maskLlmApiKey(cfg.llm.anthropic_api_key),
        openai_api_key: maskLlmApiKey(cfg.llm.openai_api_key),
        gemini_api_key: maskLlmApiKey(cfg.llm.gemini_api_key),
        perplexity_api_key: maskLlmApiKey(cfg.llm.perplexity_api_key),
        xai_api_key: maskLlmApiKey(cfg.llm.xai_api_key),
      },
      notifications: cfg.notifications,
      artifacts: cfg.artifacts,
      runtimes: Object.keys(cfg.runtimes),
    });
  });

  app.get('/api/providers', (c) => {
    return c.json(getProviderStatus());
  });

  app.put('/api/settings', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const llm = body.llm as Record<string, unknown> | undefined;
    if (llm) {
      const currentLlm = getConfig().llm;
      // Only normalize fields that were actually sent — don't overwrite missing fields
      const safeLlm: Record<string, unknown> = {};

      if ('provider' in llm) safeLlm.provider = normalizeProvider(llm.provider, currentLlm.provider);
      if ('api_key' in llm) safeLlm.api_key = preserveMaskedSecret(llm.api_key, currentLlm.api_key);
      if ('anthropic_api_key' in llm) safeLlm.anthropic_api_key = preserveMaskedSecret(llm.anthropic_api_key, currentLlm.anthropic_api_key);
      if ('openai_api_key' in llm) safeLlm.openai_api_key = preserveMaskedSecret(llm.openai_api_key, currentLlm.openai_api_key);
      if ('gemini_api_key' in llm) safeLlm.gemini_api_key = preserveMaskedSecret(llm.gemini_api_key, currentLlm.gemini_api_key);
      if ('perplexity_api_key' in llm) safeLlm.perplexity_api_key = preserveMaskedSecret(llm.perplexity_api_key, currentLlm.perplexity_api_key);
      if ('xai_api_key' in llm) safeLlm.xai_api_key = preserveMaskedSecret(llm.xai_api_key, currentLlm.xai_api_key);
      if ('base_url' in llm) safeLlm.base_url = normalizeOptionalString(llm.base_url);
      if ('model' in llm) safeLlm.model = normalizeRequiredString(llm.model, currentLlm.model);

      body.llm = safeLlm;
    }
    updateConfig(body as Partial<WaveConfig>);
    logger.info('Settings updated');
    return c.json({ ok: true });
  });

  app.put('/api/settings/api-key', async (c) => {
    const body = await c.req.json<{ key: string; provider?: string }>();
    const cfg = getConfig();
    const provider = normalizeProvider(body.provider, cfg.llm.provider);
    const apiKey = body.key.trim() || null;

    updateConfig({
      llm: {
        ...cfg.llm,
        provider,
        api_key: apiKey,
        anthropic_api_key: provider === 'anthropic' ? apiKey : cfg.llm.anthropic_api_key,
      },
    } as Partial<typeof cfg>);
    logger.info('LLM API key updated');
    return c.json({ ok: true });
  });

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const lastEventId = parseInt(
        c.req.header('Last-Event-ID') ?? c.req.query('lastEventId') ?? '0',
        10,
      );

      // The event bus calls write() synchronously, but Hono's stream.write()
      // is async. We use a queue + resolver pattern to bridge sync→async:
      // each sync write() pushes to a queue and signals a resolver that
      // an async drain loop is waiting on.
      const queue: string[] = [];
      let resolve: (() => void) | null = null;
      let closed = false;

      function signal() {
        if (resolve) {
          const r = resolve;
          resolve = null;
          r();
        }
      }

      const writer = {
        id: Math.random().toString(36).slice(2),
        write: (data: string) => {
          if (!closed) {
            queue.push(data);
            signal();
          }
        },
        close: () => {
          closed = true;
          signal();
          stream.close();
        },
      };

      subscribe(writer, lastEventId || undefined);

      const keepalive = setInterval(() => {
        if (!closed) {
          queue.push(': keepalive\n\n');
          signal();
        }
      }, 30000);

      stream.onAbort(() => {
        closed = true;
        clearInterval(keepalive);
        unsubscribe(writer);
        signal();
      });

      // Async drain loop — waits for signal, then flushes queue
      while (!closed) {
        // Wait for something to appear in the queue
        if (queue.length === 0) {
          await new Promise<void>((r) => { resolve = r; });
        }
        // Drain everything
        while (queue.length > 0 && !closed) {
          const msg = queue.shift()!;
          try {
            await stream.write(msg);
          } catch {
            closed = true;
            break;
          }
        }
      }
    });
  });
}

function normalizeProvider(value: unknown, fallback: WaveConfig['llm']['provider']): WaveConfig['llm']['provider'] {
  if (value === 'anthropic' || value === 'openai-compatible') {
    return value;
  }

  return fallback;
}

function preserveMaskedSecret(nextValue: unknown, currentValue: string | null): string | null {
  if (typeof nextValue !== 'string' || nextValue.trim() === '' || nextValue.includes('••••')) {
    return currentValue;
  }

  return nextValue.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}
