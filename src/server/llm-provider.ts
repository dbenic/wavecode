import Anthropic from '@anthropic-ai/sdk';
import { getConfig, type WaveConfig } from './config.js';
import type { Result } from './db.js';

export type LlmProvider = WaveConfig['llm']['provider'];

const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface ResolvedLlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}

export interface TextCompletionRequest {
  systemPrompt?: string;
  userMessage: string;
  maxTokens?: number;
}

export interface LlmChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
}

export interface ToolConversationRequest {
  systemPrompt: string;
  messages: LlmChatMessage[];
  tools: LlmToolDefinition[];
  maxTokens?: number;
  onToolCall: (name: string, input: Record<string, unknown>) => Promise<string>;
}

export interface ToolConversationResult {
  reply: string;
  toolCalls: string[];
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAiCompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiCompatibleResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: unknown;
      tool_calls?: OpenAiToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
}

let anthropicClient: Anthropic | null = null;
let lastAnthropicKey: string | null = null;

export function getLlmApiKey(config: WaveConfig = getConfig()): string | null {
  if (config.llm.provider === 'anthropic') {
    return config.llm.anthropic_api_key || config.llm.api_key || process.env.ANTHROPIC_API_KEY || null;
  }

  if (config.llm.api_key) {
    return config.llm.api_key;
  }

  return process.env.OPENAI_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || null;
}

export function getLlmBaseUrl(config: WaveConfig = getConfig()): string | null {
  if (config.llm.provider !== 'openai-compatible') {
    return null;
  }

  return config.llm.base_url || process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || OPENAI_COMPATIBLE_DEFAULT_BASE_URL;
}

export function getResolvedLlmConfig(): ResolvedLlmConfig {
  const config = getConfig();
  return {
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: getLlmApiKey(config),
    baseUrl: getLlmBaseUrl(config),
  };
}

export function maskLlmApiKey(apiKey: string | null): string | null {
  return apiKey ? `••••${apiKey.slice(-8)}` : null;
}

export function isLlmConfigured(): boolean {
  const config = getResolvedLlmConfig();
  if (config.provider === 'anthropic') {
    return !!config.apiKey;
  }

  return !!config.baseUrl && (!!config.apiKey || isLocalBaseUrl(config.baseUrl));
}

export async function completeText(request: TextCompletionRequest): Promise<Result<string>> {
  const config = getResolvedLlmConfig();
  const maxTokens = request.maxTokens ?? 1024;

  if (!isLlmConfigured()) {
    return { ok: false, error: getConfigurationError(config) };
  }

  if (config.provider === 'anthropic') {
    return completeAnthropicText(config, request, maxTokens);
  }

  return completeOpenAiCompatibleText(config, request, maxTokens);
}

export async function runToolConversation(request: ToolConversationRequest): Promise<Result<ToolConversationResult>> {
  const config = getResolvedLlmConfig();

  if (!isLlmConfigured()) {
    return { ok: false, error: getConfigurationError(config) };
  }

  if (config.provider === 'anthropic') {
    return runAnthropicToolConversation(config, request);
  }

  return runOpenAiCompatibleToolConversation(config, request);
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '0.0.0.0'
      || url.hostname === '::1'
      || url.hostname.endsWith('.local');
  } catch {
    return false;
  }
}

function getConfigurationError(config: ResolvedLlmConfig): string {
  if (config.provider === 'anthropic') {
    return 'LLM not configured. Set an Anthropic API key in Settings or ANTHROPIC_API_KEY on the server.';
  }

  if (!config.baseUrl || config.baseUrl === OPENAI_COMPATIBLE_DEFAULT_BASE_URL) {
    return 'LLM not configured. Set an OpenAI-compatible base URL, or provide an API key for the default OpenAI endpoint.';
  }

  return 'LLM not configured. Set an API key, or point the provider at a local OpenAI-compatible endpoint.';
}

function getAnthropicClient(apiKey: string): Anthropic {
  if (anthropicClient && apiKey === lastAnthropicKey) {
    return anthropicClient;
  }

  lastAnthropicKey = apiKey;
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

async function completeAnthropicText(
  config: ResolvedLlmConfig,
  request: TextCompletionRequest,
  maxTokens: number,
): Promise<Result<string>> {
  if (!config.apiKey) {
    return { ok: false, error: getConfigurationError(config) };
  }

  try {
    const client = getAnthropicClient(config.apiKey);
    const response = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userMessage }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return { ok: true, data: text };
  } catch (error) {
    return { ok: false, error: `LLM API error: ${(error as Error).message}` };
  }
}

async function completeOpenAiCompatibleText(
  config: ResolvedLlmConfig,
  request: TextCompletionRequest,
  maxTokens: number,
): Promise<Result<string>> {
  try {
    const response = await postOpenAiCompatibleChatCompletion(config, {
      model: config.model,
      max_tokens: maxTokens,
      messages: buildOpenAiMessages(request.systemPrompt, [
        { role: 'user', content: request.userMessage },
      ]),
    });

    const text = extractOpenAiText(response.choices?.[0]?.message?.content).trim();
    return { ok: true, data: text };
  } catch (error) {
    return { ok: false, error: `LLM API error: ${(error as Error).message}` };
  }
}

async function runAnthropicToolConversation(
  config: ResolvedLlmConfig,
  request: ToolConversationRequest,
): Promise<Result<ToolConversationResult>> {
  if (!config.apiKey) {
    return { ok: false, error: getConfigurationError(config) };
  }

  try {
    const client = getAnthropicClient(config.apiKey);
    const tools: Anthropic.Tool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    const messages: Anthropic.MessageParam[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const toolCalls: string[] = [];

    let response = await client.messages.create({
      model: config.model,
      max_tokens: request.maxTokens ?? 2048,
      system: request.systemPrompt,
      tools,
      messages,
    });

    const maxRounds = 15;
    let rounds = 0;

    while (response.stop_reason === 'tool_use' && rounds < maxRounds) {
      rounds += 1;
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const result = await request.onToolCall(block.name, block.input as Record<string, unknown>);
        toolCalls.push(`${block.name}: ${result}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: config.model,
        max_tokens: request.maxTokens ?? 2048,
        system: request.systemPrompt,
        tools,
        messages,
      });
    }

    if (rounds >= maxRounds && response.stop_reason === 'tool_use') {
      return { ok: false, error: 'LLM stopped after too many tool rounds.' };
    }

    const reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return { ok: true, data: { reply, toolCalls } };
  } catch (error) {
    return { ok: false, error: `LLM API error: ${(error as Error).message}` };
  }
}

async function runOpenAiCompatibleToolConversation(
  config: ResolvedLlmConfig,
  request: ToolConversationRequest,
): Promise<Result<ToolConversationResult>> {
  const toolCalls: string[] = [];
  const messages = buildOpenAiMessages(request.systemPrompt, request.messages);
  const tools = request.tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  try {
    const maxRounds = 15;

    for (let round = 0; round < maxRounds; round += 1) {
      const response = await postOpenAiCompatibleChatCompletion(config, {
        model: config.model,
        max_tokens: request.maxTokens ?? 2048,
        messages,
        tools,
        tool_choice: 'auto',
      });

      const assistantMessage = response.choices?.[0]?.message;
      const assistantText = extractOpenAiText(assistantMessage?.content);
      const assistantToolCalls = assistantMessage?.tool_calls ?? [];

      if (assistantToolCalls.length === 0) {
        return {
          ok: true,
          data: {
            reply: assistantText.trim(),
            toolCalls,
          },
        };
      }

      messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: assistantToolCalls,
      });

      for (const toolCall of assistantToolCalls) {
        let input: Record<string, unknown> = {};
        try {
          input = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) as Record<string, unknown> : {};
        } catch {
          input = {};
        }

        const result = await request.onToolCall(toolCall.function.name, input);
        toolCalls.push(`${toolCall.function.name}: ${result}`);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    return { ok: false, error: 'LLM stopped after too many tool rounds.' };
  } catch (error) {
    return { ok: false, error: `LLM API error: ${(error as Error).message}` };
  }
}

function buildOpenAiMessages(systemPrompt: string | undefined, messages: LlmChatMessage[]): OpenAiCompatibleMessage[] {
  const result: OpenAiCompatibleMessage[] = [];
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const message of messages) {
    result.push({
      role: message.role,
      content: message.content,
    });
  }

  return result;
}

async function postOpenAiCompatibleChatCompletion(
  config: ResolvedLlmConfig,
  payload: Record<string, unknown>,
): Promise<OpenAiCompatibleResponse> {
  if (!config.baseUrl) {
    throw new Error(getConfigurationError(config));
  }

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });

  const raw = await response.text();
  let parsed: OpenAiCompatibleResponse;

  try {
    parsed = raw ? JSON.parse(raw) as OpenAiCompatibleResponse : {};
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${raw.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(parsed.error?.message || `HTTP ${response.status} from ${url}`);
  }

  return parsed;
}

function extractOpenAiText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object') {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}
