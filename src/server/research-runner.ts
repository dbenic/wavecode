import Anthropic from '@anthropic-ai/sdk';
import {
  insertResearchRun,
  getResearchRun,
  appendResearchOutput,
  finishResearchRun,
  type ResearchRun,
  type Result,
} from './db.js';
import {
  getAnthropicApiKey,
  getOpenAIApiKey,
  getGeminiApiKey,
  getPerplexityApiKey,
  getXAIApiKey,
} from './config.js';
import { emit } from './event-bus.js';
import logger from './logger.js';

/**
 * Research runner — executes a research job via an LLM provider with web search,
 * streams output to the event bus, stores final spec in DB.
 *
 * This is a JOB, not a chat. Each run is one-shot: prompt → spec → artifact-ready output.
 */

export type ResearchProvider = 'anthropic' | 'openai' | 'gemini' | 'perplexity' | 'xai';

export interface RunResearchOpts {
  prompt: string;
  model?: string;
  provider?: ResearchProvider;
  targetAgentId?: string | null;
  parentRunId?: string | null;
  /** Override the auto-derived title */
  title?: string;
}

/** Pricing per 1M tokens, USD. Update as models change. */
const PRICING: Record<string, { in: number; out: number }> = {
  // Anthropic
  'claude-opus-4-5': { in: 15, out: 75 },
  'claude-opus-4-6': { in: 15, out: 75 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  // OpenAI
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'gpt-5.4': { in: 5, out: 20 },
  'gpt-5.4-mini': { in: 1, out: 4 },
  'gpt-5.4-pro': { in: 15, out: 60 },
  'o3': { in: 2, out: 8 },
  'o3-pro': { in: 20, out: 80 },
  'o4-mini': { in: 1.1, out: 4.4 },
  // Gemini
  'gemini-2.5-pro': { in: 2.5, out: 15 },
  'gemini-2.5-flash': { in: 0.15, out: 0.6 },
  // Perplexity
  'sonar-pro': { in: 3, out: 15 },
  'sonar': { in: 1, out: 1 },
  'sonar-deep-research': { in: 2, out: 8 },
  // xAI
  'grok-3': { in: 3, out: 15 },
  'grok-3-mini': { in: 0.3, out: 0.5 },
};

const WEB_SEARCH_COST_PER_CALL = 0.01; // $10 per 1000 searches

function computeCost(model: string, tokensIn: number, tokensOut: number, searches: number): number {
  const p = PRICING[model] ?? { in: 3, out: 15 }; // fallback to mid-range
  const tokens = (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
  return tokens + searches * WEB_SEARCH_COST_PER_CALL;
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0] ?? prompt;
  return firstLine.slice(0, 80);
}

const SYSTEM_PROMPT = `You are a research agent producing a high-quality technical specification document.

When given a goal, you:
1. Use the web search tool liberally to gather current, authoritative information
2. Synthesize findings into a clear, actionable markdown spec
3. Structure the output with: Overview, Key Findings, Recommendations, Implementation Notes, Sources

Your output should be **the final spec only** — ready to be consumed by a coding agent.
Do NOT include conversational preamble like "I'll research this for you." Just produce the spec.
Use proper markdown: headings, bullet lists, code blocks where appropriate, and inline links to sources.`;

/** Default model per provider */
const PROVIDER_DEFAULTS: Record<ResearchProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.4',
  gemini: 'gemini-2.5-pro',
  perplexity: 'sonar-pro',
  xai: 'grok-3',
};

/** Resolve API key for a provider */
function getApiKey(provider: ResearchProvider): string | null {
  switch (provider) {
    case 'anthropic': return getAnthropicApiKey();
    case 'openai': return getOpenAIApiKey();
    case 'gemini': return getGeminiApiKey();
    case 'perplexity': return getPerplexityApiKey();
    case 'xai': return getXAIApiKey();
  }
}

/** Provider base URLs */
const PROVIDER_BASE_URLS: Record<ResearchProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  perplexity: 'https://api.perplexity.ai',
  xai: 'https://api.x.ai/v1',
};

/**
 * Create a new research run and start streaming. Returns immediately with the run record;
 * the actual work happens in the background and streams via event-bus.
 */
export function startResearchRun(opts: RunResearchOpts): Result<ResearchRun> {
  const provider: ResearchProvider = opts.provider ?? 'anthropic';
  const model = opts.model ?? PROVIDER_DEFAULTS[provider];

  const apiKey = getApiKey(provider);
  if (!apiKey) {
    return { ok: false, error: `${provider} API key not configured. Set it in Settings → Research Providers.` };
  }

  const run = insertResearchRun({
    title: opts.title ?? deriveTitle(opts.prompt),
    prompt: opts.prompt,
    provider,
    model,
    target_agent_id: opts.targetAgentId ?? null,
    parent_run_id: opts.parentRunId ?? null,
  });

  emit('research.started', 'research_run', run.id, { title: run.title, model, provider });

  // Fire-and-forget async execution
  const executor = provider === 'anthropic'
    ? executeAnthropicRun(run)
    : executeOpenAICompatibleRun(run, provider);

  void executor.catch((err) => {
    logger.error({ err: (err as Error).message, runId: run.id }, 'Research run crashed');
  });

  return { ok: true, data: run };
}

// ─── Anthropic execution (native SDK with web_search tool) ───

async function executeAnthropicRun(run: ResearchRun): Promise<void> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    finalizeWithError(run.id, 'Anthropic API key missing');
    return;
  }

  const client = new Anthropic({ apiKey });
  const buffer: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let searchCount = 0;

  try {
    const stream = client.messages.stream({
      model: run.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 10,
        } as unknown as Anthropic.Tool,
      ],
      messages: [{ role: 'user', content: run.prompt }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        buffer.push(chunk);
        if (buffer.join('').length > 200) {
          const flush = buffer.join('');
          buffer.length = 0;
          appendResearchOutput(run.id, flush);
          emit('research.chunk', 'research_run', run.id, { chunk: flush });
        }
      } else if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') {
        searchCount += 1;
        emit('research.tool_use', 'research_run', run.id, { name: 'web_search', count: searchCount });
      } else if (event.type === 'message_delta' && event.usage) {
        tokensIn = event.usage.input_tokens ?? tokensIn;
        tokensOut = event.usage.output_tokens ?? tokensOut;
      }
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
      const flush = buffer.join('');
      appendResearchOutput(run.id, flush);
      emit('research.chunk', 'research_run', run.id, { chunk: flush });
    }

    const finalMessage = await stream.finalMessage();
    tokensIn = finalMessage.usage.input_tokens ?? tokensIn;
    tokensOut = finalMessage.usage.output_tokens ?? tokensOut;

    const cost = computeCost(run.model, tokensIn, tokensOut, searchCount);
    finishResearchRun(run.id, {
      status: 'done',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost,
    });
    emit('research.finished', 'research_run', run.id, {
      status: 'done',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost,
      searches: searchCount,
    });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ err: msg, runId: run.id }, 'Research run failed');
    finalizeWithError(run.id, msg);
  }
}

// ─── OpenAI-compatible execution (OpenAI, Gemini, Perplexity, xAI) ───

interface OAIStreamChoice {
  delta: { content?: string; role?: string };
}

interface OAIStreamChunk {
  choices?: OAIStreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function executeOpenAICompatibleRun(run: ResearchRun, provider: ResearchProvider): Promise<void> {
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    finalizeWithError(run.id, `${provider} API key missing`);
    return;
  }

  const baseUrl = PROVIDER_BASE_URLS[provider];
  const buffer: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  // Detect OpenAI reasoning models (o-series) — they need special handling
  const isReasoningModel = provider === 'openai' && /^o[0-9]/.test(run.model);

  // Build request body — provider-specific tweaks
  const body: Record<string, unknown> = {
    model: run.model,
    stream: true,
  };

  if (isReasoningModel) {
    // Reasoning models (o3, o3-pro, o4-mini) don't support system messages or max_tokens
    // They use 'developer' role instead of 'system', and max_completion_tokens instead
    body.max_completion_tokens = 16384;
    body.messages = [
      { role: 'developer', content: SYSTEM_PROMPT },
      { role: 'user', content: run.prompt },
    ];
    // o3/o4 support web search via tool
    body.tools = [{ type: 'web_search_preview' }];
  } else {
    body.max_tokens = 8192;
    body.messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: run.prompt },
    ];

    // OpenAI GPT models: web_search_preview tool
    if (provider === 'openai') {
      body.tools = [{ type: 'web_search_preview' }];
    }
  }

  // Perplexity has built-in web search — no extra config needed, it searches by default
  // xAI: Grok supports live search with search parameters
  if (provider === 'xai') {
    body.search_parameters = { mode: 'auto' };
  }

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown error');
      finalizeWithError(run.id, `${provider} API error ${res.status}: ${errorText.slice(0, 200)}`);
      return;
    }

    if (!res.body) {
      finalizeWithError(run.id, 'No response body from provider');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let partial = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      partial += decoder.decode(value, { stream: true });
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data) as OAIStreamChunk;

          // Extract text content
          const content = chunk.choices?.[0]?.delta?.content;
          if (content) {
            buffer.push(content);
            if (buffer.join('').length > 200) {
              const flush = buffer.join('');
              buffer.length = 0;
              appendResearchOutput(run.id, flush);
              emit('research.chunk', 'research_run', run.id, { chunk: flush });
            }
          }

          // Capture usage if present (some providers send it in the final chunk)
          if (chunk.usage) {
            tokensIn = chunk.usage.prompt_tokens ?? tokensIn;
            tokensOut = chunk.usage.completion_tokens ?? tokensOut;
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
      const flush = buffer.join('');
      appendResearchOutput(run.id, flush);
      emit('research.chunk', 'research_run', run.id, { chunk: flush });
    }

    // If we didn't get usage from stream, try to estimate
    if (tokensIn === 0 && tokensOut === 0) {
      // Read back output to estimate tokens
      const finalRun = getResearchRun(run.id);
      if (finalRun.ok) {
        tokensOut = Math.ceil(finalRun.data.output_md.length / 4);
        tokensIn = Math.ceil(run.prompt.length / 4) + Math.ceil(SYSTEM_PROMPT.length / 4);
      }
    }

    const cost = computeCost(run.model, tokensIn, tokensOut, 0);
    finishResearchRun(run.id, {
      status: 'done',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost,
    });
    emit('research.finished', 'research_run', run.id, {
      status: 'done',
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost,
      searches: 0,
    });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ err: msg, runId: run.id }, 'Research run failed');
    finalizeWithError(run.id, msg);
  }
}

function finalizeWithError(runId: string, message: string): void {
  finishResearchRun(runId, { status: 'failed', error: message });
  emit('research.finished', 'research_run', runId, { status: 'failed', error: message });
}

/** Re-run a previous research with its output prepended as seed context. */
export function forkResearchRun(parentId: string, newPrompt: string): Result<ResearchRun> {
  const parent = getResearchRun(parentId);
  if (!parent.ok) return parent;
  const seedContext = parent.data.output_md
    ? `\n\n---\n**Previous research output (for reference):**\n\n${parent.data.output_md}\n\n---\n\n`
    : '';
  return startResearchRun({
    prompt: `${newPrompt}${seedContext}`,
    model: parent.data.model,
    provider: parent.data.provider as ResearchProvider,
    parentRunId: parentId,
    title: `fork: ${parent.data.title.slice(0, 60)}`,
  });
}
