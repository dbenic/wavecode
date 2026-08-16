/**
 * WaveCode MCP server — stdio transport.
 *
 * Launched via `wavecode mcp` (or `node dist/mcp/index.js`). Connects any
 * MCP-capable client (Claude Code, Grok, custom orchestrators) to a local
 * or remote WaveCode daemon over its REST API.
 *
 * Configuration (flags override env):
 *   WAVECODE_URL    daemon base URL (default http://localhost:3777)
 *   WAVECODE_TOKEN  bearer token when the daemon uses token auth
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WaveCodeClient } from './client.js';
import { registerWaveCodeTools } from './tools.js';

export interface McpServerOptions {
  url?: string;
  token?: string;
}

export function buildMcpServer(opts: McpServerOptions = {}): McpServer {
  const client = new WaveCodeClient({
    baseUrl: opts.url ?? process.env.WAVECODE_URL ?? 'http://localhost:3777',
    token: opts.token ?? process.env.WAVECODE_TOKEN ?? null,
  });

  const server = new McpServer({
    name: 'wavecode',
    version: '0.1.0',
  });

  registerWaveCodeTools(server, client);
  return server;
}

export async function runStdioMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const server = buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP protocol channel
  console.error(`WaveCode MCP server connected (daemon: ${opts.url ?? process.env.WAVECODE_URL ?? 'http://localhost:3777'})`);
}
