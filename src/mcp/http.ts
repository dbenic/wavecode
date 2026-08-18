/**
 * Streamable HTTP MCP transport for the WaveCode daemon.
 *
 * Served at `/mcp` (not under `/api`) so existing `/api/*` CORS + auth
 * middleware stays unchanged. Auth is the same rule: `createAuthMiddleware()`
 * (Tailscale and/or bearer `fallback_token`). Never log the token.
 *
 * Uses the SDK's web-standard Streamable HTTP transport (the core of
 * `StreamableHTTPServerTransport`) so Hono `app.fetch()` and Cursor / Grok Bot
 * remote connectors speak the same protocol. Stdio `wavecode mcp` is unchanged.
 */

import { randomUUID } from 'node:crypto';
import { cors } from 'hono/cors';
import type { Context, Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAuthMiddleware, type NodeAppEnv } from '../server/auth.js';
import logger from '../server/logger.js';
import { buildMcpServer, type McpServerOptions } from './index.js';

export const MCP_HTTP_PATH = '/mcp';
export const MCP_SESSION_HEADER = 'mcp-session-id';

const MCP_CORS_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'Last-Event-ID',
];

interface HttpMcpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

export interface McpHttpHandler {
  (c: Context<NodeAppEnv>): Promise<Response>;
  closeAll(): Promise<void>;
}

function asMessages(body: unknown): unknown[] {
  if (body == null) return [];
  return Array.isArray(body) ? body : [body];
}

function includesInitialize(body: unknown): boolean {
  return asMessages(body).some((msg) => isInitializeRequest(msg));
}

async function safeClose(session: HttpMcpSession): Promise<void> {
  try {
    await session.transport.close();
  } catch {
    // already closed
  }
  try {
    await session.server.close();
  } catch {
    // already closed
  }
}

/**
 * JSON-RPC Streamable HTTP handler. Sessions are keyed by `mcp-session-id`
 * (returned on initialize). Idle GET SSE keep-alives and client disconnects
 * must not exit the daemon — we only drop that session.
 */
export function createMcpHttpHandler(opts: McpServerOptions = {}): McpHttpHandler {
  const sessions = new Map<string, HttpMcpSession>();

  const handler = (async (c: Context<NodeAppEnv>): Promise<Response> => {
    try {
      const sessionId = c.req.header(MCP_SESSION_HEADER)?.trim() || undefined;
      let parsedBody: unknown;
      if (c.req.method === 'POST') {
        try {
          parsedBody = await c.req.json();
        } catch {
          return c.json(
            { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
            400,
          );
        }
      }

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          return c.json(
            { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
            404,
          );
        }
        return await existing.transport.handleRequest(c.req.raw, { parsedBody });
      }

      if (c.req.method === 'POST' && includesInitialize(parsedBody)) {
        const server = buildMcpServer(opts);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
          },
          onsessionclosed: (id) => {
            const slot = sessions.get(id);
            sessions.delete(id);
            if (slot) void slot.server.close().catch(() => undefined);
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (!id) return;
          const slot = sessions.get(id);
          sessions.delete(id);
          if (slot) void slot.server.close().catch(() => undefined);
        };
        transport.onerror = (err) => {
          logger.warn({ error: err.message }, 'MCP HTTP transport error');
        };

        await server.connect(transport);
        const response = await transport.handleRequest(c.req.raw, { parsedBody });
        if (!transport.sessionId) {
          await safeClose({ transport, server });
        }
        return response;
      }

      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        },
        400,
      );
    } catch (err) {
      logger.error({ error: (err as Error).message, path: MCP_HTTP_PATH }, 'MCP HTTP request failed');
      return c.json(
        { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
        500,
      );
    }
  }) as McpHttpHandler;

  handler.closeAll = async () => {
    const open = [...sessions.values()];
    sessions.clear();
    await Promise.all(open.map((slot) => safeClose(slot)));
  };

  return handler;
}

/** Mount `/mcp` with the same auth rule as `/api/*`, plus MCP CORS headers. */
export function registerMcpHttpRoutes(
  app: Hono<NodeAppEnv>,
  opts: McpServerOptions = {},
): McpHttpHandler {
  app.use(
    MCP_HTTP_PATH,
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: MCP_CORS_HEADERS,
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    }),
  );
  app.use(MCP_HTTP_PATH, createAuthMiddleware());
  const handler = createMcpHttpHandler(opts);
  app.on(['POST', 'GET', 'DELETE'], MCP_HTTP_PATH, handler);
  return handler;
}
