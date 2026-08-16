/**
 * WaveCode MCP server — stdio transport.
 *
 * Launched via `wavecode mcp` (or `node dist/mcp/index.js`). Connects any
 * MCP-capable client (Claude Code, Grok, custom orchestrators) to a local
 * or remote WaveCode daemon over its REST API.
 *
 * Connection (flags override env override config):
 *   --url / WAVECODE_URL / config server.host+port
 *   --token / WAVECODE_TOKEN / auth.fallback_token
 *
 * Never log the token.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveDaemonConnection } from '../cli/daemon-connection.js';
import { WaveCodeClient } from './client.js';
import { registerWaveCodeTools } from './tools.js';

export interface McpServerOptions {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export function createMcpClient(opts: McpServerOptions = {}): WaveCodeClient {
  const conn = resolveDaemonConnection();
  return new WaveCodeClient({
    baseUrl: opts.url ?? conn.url,
    token: opts.token ?? conn.token,
    fetchImpl: opts.fetchImpl,
  });
}

export function buildMcpServer(opts: McpServerOptions = {}): McpServer {
  const client = createMcpClient(opts);

  const server = new McpServer({
    name: 'wavecode',
    version: '0.1.0',
  });

  registerWaveCodeTools(server, client);
  return server;
}

export async function runStdioMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const conn = resolveDaemonConnection();
  const server = buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP protocol channel. Do not print the token.
  console.error(`WaveCode MCP server connected (daemon: ${opts.url ?? conn.url})`);
}
