import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('llm-provider.ts', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-llm-provider-'));
    configPath = path.join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves the Anthropic API key from the legacy config field', async () => {
    const { loadConfig, updateConfig } = await import('./config.js');
    loadConfig(configPath);
    updateConfig({
      llm: {
        provider: 'anthropic',
        api_key: null,
        anthropic_api_key: 'sk-ant-12345678',
        openai_api_key: null,
        gemini_api_key: null,
        perplexity_api_key: null,
        xai_api_key: null,
        base_url: null,
        model: 'claude-sonnet-4-20250514',
      },
    });

    const { getResolvedLlmConfig, maskLlmApiKey } = await import('./llm-provider.js');
    const llm = getResolvedLlmConfig();

    expect(llm.provider).toBe('anthropic');
    expect(llm.apiKey).toBe('sk-ant-12345678');
    expect(maskLlmApiKey(llm.apiKey)).toBe('••••12345678');
  });

  it('treats a local OpenAI-compatible endpoint as configured without an API key', async () => {
    const { loadConfig, updateConfig } = await import('./config.js');
    loadConfig(configPath);
    updateConfig({
      llm: {
        provider: 'openai-compatible',
        api_key: null,
        anthropic_api_key: null,
        openai_api_key: null,
        gemini_api_key: null,
        perplexity_api_key: null,
        xai_api_key: null,
        base_url: 'http://127.0.0.1:11434/v1',
        model: 'gemma4',
      },
    });

    const { isLlmConfigured, getResolvedLlmConfig } = await import('./llm-provider.js');
    const llm = getResolvedLlmConfig();

    expect(llm.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(isLlmConfigured()).toBe(true);
  });

  it('sends text completions to an OpenAI-compatible endpoint', async () => {
    const { loadConfig, updateConfig } = await import('./config.js');
    loadConfig(configPath);
    updateConfig({
      llm: {
        provider: 'openai-compatible',
        api_key: null,
        anthropic_api_key: null,
        openai_api_key: null,
        gemini_api_key: null,
        perplexity_api_key: null,
        xai_api_key: null,
        base_url: 'http://127.0.0.1:11434/v1',
        model: 'gemma4',
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: 'Refined prompt output',
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { completeText } = await import('./llm-provider.js');
    const result = await completeText({
      systemPrompt: 'System prompt',
      userMessage: 'Original prompt',
      maxTokens: 256,
    });

    expect(result).toEqual({ ok: true, data: 'Refined prompt output' });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(options.body as string) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gemma4');
    expect(body.max_tokens).toBe(256);
    expect(body.messages).toEqual([
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Original prompt' },
    ]);
  });
});
