import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const anthropicStreamMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(function Anthropic() {
    return {
      messages: {
        stream: anthropicStreamMock,
      },
    };
  }),
}));

vi.mock('./db.js', () => ({
  insertResearchRun: vi.fn(),
  getResearchRun: vi.fn(),
  appendResearchOutput: vi.fn(),
  finishResearchRun: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getAnthropicApiKey: vi.fn(),
  getOpenAIApiKey: vi.fn(),
  getGeminiApiKey: vi.fn(),
  getPerplexityApiKey: vi.fn(),
  getXAIApiKey: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('research-runner.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects starting a research run when the provider API key is missing', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    vi.mocked(config.getAnthropicApiKey).mockReturnValue(null);

    const runner = await import('./research-runner.js');
    const result = runner.startResearchRun({ prompt: 'Research auth hardening' });

    expect(result).toEqual({
      ok: false,
      error: 'anthropic API key not configured. Set it in Settings → Research Providers.',
    });
    expect(db.insertResearchRun).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('streams OpenAI-compatible research output and finalizes with reported usage', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');

    vi.mocked(config.getOpenAIApiKey).mockReturnValue('sk-openai');
    vi.mocked(db.insertResearchRun).mockReturnValue(makeRun({
      id: 'run-openai',
      title: 'Research auth hardening',
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Research auth hardening',
    }) as never);

    const fetchMock = vi.fn().mockResolvedValue(createSseResponse([
      'data: {"choices":[{"delta":{"content":"Overview\\n- tighten auth\\n"}}]}\n',
      'data: {"usage":{"prompt_tokens":120,"completion_tokens":45}}\n',
      'data: [DONE]\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const runner = await import('./research-runner.js');
    const result = runner.startResearchRun({
      prompt: 'Research auth hardening',
      provider: 'openai',
      model: 'gpt-5.4',
    });

    expect(result).toEqual({
      ok: true,
      data: makeRun({
        id: 'run-openai',
        title: 'Research auth hardening',
        provider: 'openai',
        model: 'gpt-5.4',
        prompt: 'Research auth hardening',
      }),
    });

    await waitForCondition(() => {
      expect(db.finishResearchRun).toHaveBeenCalledWith(
        'run-openai',
        expect.objectContaining({
          status: 'done',
          tokens_in: 120,
          tokens_out: 45,
        }),
      );
    });

    expect(db.appendResearchOutput).toHaveBeenCalledWith('run-openai', 'Overview\n- tighten auth\n');
    expect(events.emit).toHaveBeenCalledWith(
      'research.started',
      'research_run',
      'run-openai',
      { title: 'Research auth hardening', model: 'gpt-5.4', provider: 'openai' },
    );
    expect(events.emit).toHaveBeenCalledWith(
      'research.chunk',
      'research_run',
      'run-openai',
      { chunk: 'Overview\n- tighten auth\n' },
    );

    const finishFields = vi.mocked(db.finishResearchRun).mock.calls[0]?.[1] as {
      cost_usd: number;
    };
    expect(finishFields.cost_usd).toBeCloseTo(0.0015, 8);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options.body as string) as {
      max_tokens?: number;
      max_completion_tokens?: number;
      tools?: Array<{ type: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.max_tokens).toBe(8192);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.messages[0]?.role).toBe('system');
    expect(body.tools).toEqual([{ type: 'web_search_preview' }]);
  });

  it('uses the reasoning-model request shape for OpenAI o-series runs', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');

    vi.mocked(config.getOpenAIApiKey).mockReturnValue('sk-openai');
    vi.mocked(db.insertResearchRun).mockReturnValue(makeRun({
      id: 'run-o3',
      title: 'Research retries',
      provider: 'openai',
      model: 'o3',
      prompt: 'Research retries',
    }) as never);

    const fetchMock = vi.fn().mockResolvedValue(createSseResponse([
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n',
      'data: [DONE]\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const runner = await import('./research-runner.js');
    runner.startResearchRun({
      prompt: 'Research retries',
      provider: 'openai',
      model: 'o3',
    });

    await waitForCondition(() => {
      expect(db.finishResearchRun).toHaveBeenCalledWith(
        'run-o3',
        expect.objectContaining({ status: 'done' }),
      );
    });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as {
      max_tokens?: number;
      max_completion_tokens?: number;
      tools?: Array<{ type: string }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(16384);
    expect(body.messages[0]?.role).toBe('developer');
    expect(body.tools).toEqual([{ type: 'web_search_preview' }]);
  });

  it('streams Anthropic research output, tracks tool use, and finalizes cost', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');

    vi.mocked(config.getAnthropicApiKey).mockReturnValue('sk-ant');
    vi.mocked(db.insertResearchRun).mockReturnValue(makeRun({
      id: 'run-ant',
      title: 'Research monitoring',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      prompt: 'Research monitoring',
    }) as never);

    anthropicStreamMock.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_start', content_block: { type: 'server_tool_use' } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Spec body\n' } };
        yield { type: 'message_delta', usage: { input_tokens: 200, output_tokens: 50 } };
      },
      finalMessage: vi.fn().mockResolvedValue({
        usage: { input_tokens: 200, output_tokens: 50 },
      }),
    } as never);

    const runner = await import('./research-runner.js');
    runner.startResearchRun({
      prompt: 'Research monitoring',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    await waitForCondition(() => {
      expect(db.finishResearchRun).toHaveBeenCalledWith(
        'run-ant',
        expect.objectContaining({
          status: 'done',
          tokens_in: 200,
          tokens_out: 50,
        }),
      );
    });

    expect(db.appendResearchOutput).toHaveBeenCalledWith('run-ant', 'Spec body\n');
    expect(events.emit).toHaveBeenCalledWith(
      'research.tool_use',
      'research_run',
      'run-ant',
      { name: 'web_search', count: 1 },
    );

    const finishFields = vi.mocked(db.finishResearchRun).mock.calls[0]?.[1] as {
      cost_usd: number;
    };
    expect(finishFields.cost_usd).toBeCloseTo(0.01135, 8);
  });

  it('finalizes failed research runs when the provider returns an error response', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');

    vi.mocked(config.getOpenAIApiKey).mockReturnValue('sk-openai');
    vi.mocked(db.insertResearchRun).mockReturnValue(makeRun({
      id: 'run-failed',
      title: 'Research failures',
      provider: 'openai',
      model: 'gpt-5.4',
      prompt: 'Research failures',
    }) as never);

    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', {
      status: 429,
      headers: { 'Content-Type': 'text/plain' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const runner = await import('./research-runner.js');
    runner.startResearchRun({
      prompt: 'Research failures',
      provider: 'openai',
      model: 'gpt-5.4',
    });

    await waitForCondition(() => {
      expect(db.finishResearchRun).toHaveBeenCalledWith(
        'run-failed',
        {
          status: 'failed',
          error: 'openai API error 429: rate limited',
        },
      );
    });
    expect(events.emit).toHaveBeenCalledWith(
      'research.finished',
      'research_run',
      'run-failed',
      { status: 'failed', error: 'openai API error 429: rate limited' },
    );
  });
});

function makeRun(overrides: Partial<{
  id: string;
  title: string;
  prompt: string;
  provider: string;
  model: string;
}> = {}) {
  return {
    id: 'run-1',
    title: 'Research task',
    prompt: 'Research task',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    status: 'running' as const,
    output_md: '',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    error: null,
    target_agent_id: null,
    artifact_id: null,
    parent_run_id: null,
    created_at: '2026-04-09T00:00:00Z',
    finished_at: null,
    ...overrides,
  };
}

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

async function waitForCondition(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Condition was not met before timeout');
}
