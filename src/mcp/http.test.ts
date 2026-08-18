/**
 * Streamable HTTP MCP on /mcp: bearer auth, initialize, one tool call.
 * Stdio `wavecode mcp` stays a separate entrypoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createAuthMiddleware, type NodeAppEnv } from '../server/auth.js';
import type { WaveConfig } from '../server/config.js';
import { createMcpHttpHandler, MCP_HTTP_PATH, MCP_SESSION_HEADER } from './http.js';
import { buildMcpServer, runStdioMcpServer } from './index.js';

vi.mock('../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const TEST_TOKEN = 'mcp-http-test-token';

function makeAuthConfig(): WaveConfig {
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
    autonomy: {
      auto_dispatch: true,
      auto_restart: true,
      hang_timeout_min: 10,
      max_task_retries: 2,
      verify_completion: false,
    },
    sandbox: { disable_git_push: true, restrict_network: true },
    runtimes: {},
    auth: {
      method: 'token',
      fallback_token: TEST_TOKEN,
      trusted_proxies: [],
    },
    notifications: {
      web_push: false,
      ntfy_topic: null,
      telegram_bot_token: null,
      telegram_chat_id: null,
    },
    artifacts: { storage: '/tmp/wavecode/artifacts', retention_days: 30 },
    projects: {},
    review: {
      auto_review: false,
      default_reviewer: 'aider',
      self_review: true,
      max_fix_loops: 2,
      require_pass_to_promote: false,
      gate_dependents_on_approval: false,
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
    },
  };
}

function mcpHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extra,
  };
}

async function parseMcpBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (!text) return null;
  if (contentType.includes('text/event-stream')) {
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = dataLines.at(-1);
    return last ? JSON.parse(last) : null;
  }
  return JSON.parse(text);
}

describe('HTTP MCP /mcp', () => {
  let handler: ReturnType<typeof createMcpHttpHandler>;
  let app: Hono<NodeAppEnv>;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/agents')) {
        return new Response(JSON.stringify([{ id: 'agent-1', name: 'grok-fe', status: 'idle' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not mocked' }), { status: 404 });
    });

    handler = createMcpHttpHandler({
      url: 'http://127.0.0.1:3777',
      token: TEST_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    app = new Hono<NodeAppEnv>();
    app.use(MCP_HTTP_PATH, createAuthMiddleware(() => makeAuthConfig()));
    app.on(['POST', 'GET', 'DELETE'], MCP_HTTP_PATH, handler);
  });

  afterEach(async () => {
    await handler.closeAll();
  });

  it('returns 401 when the bearer token is missing', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token is wrong', async () => {
    const response = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: mcpHeaders({ Authorization: 'Bearer wrong-token' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('initializes and calls list_agents on the same HTTP session', async () => {
    const initResponse = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: mcpHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test', version: '0.0.0' },
          },
        }),
      }),
    );

    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get(MCP_SESSION_HEADER);
    expect(sessionId).toBeTruthy();

    const initBody = (await parseMcpBody(initResponse)) as {
      result?: { serverInfo?: { name?: string }; protocolVersion?: string };
    };
    expect(initBody.result?.serverInfo?.name).toBe('wavecode');

    const initialized = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: mcpHeaders({
          [MCP_SESSION_HEADER]: sessionId!,
          'mcp-protocol-version': initBody.result?.protocolVersion ?? LATEST_PROTOCOL_VERSION,
        }),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
    );
    expect(initialized.status).toBe(202);

    const toolResponse = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: mcpHeaders({
          [MCP_SESSION_HEADER]: sessionId!,
          'mcp-protocol-version': initBody.result?.protocolVersion ?? LATEST_PROTOCOL_VERSION,
        }),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_agents', arguments: {} },
        }),
      }),
    );

    expect(toolResponse.status).toBe(200);
    const toolBody = (await parseMcpBody(toolResponse)) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };
    expect(toolBody.error).toBeUndefined();
    expect(toolBody.result?.isError).toBeFalsy();
    const text = toolBody.result?.content?.[0]?.text ?? '';
    expect(text).toContain('agent-1');
    expect(text).toContain('grok-fe');
    expect(fetchImpl).toHaveBeenCalled();
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://127.0.0.1:3777/api/agents');
  });

  it('stdio helpers remain available', () => {
    expect(typeof runStdioMcpServer).toBe('function');
    const server = buildMcpServer({
      url: 'http://127.0.0.1:3777',
      token: TEST_TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(server).toBeTruthy();
  });
});
