/**
 * WebSocket endpoint for the live terminal view: `GET /api/agents/:id/terminal`
 * upgraded to a socket. This is the one WebSocket WaveCode has; every other
 * live update stays on SSE.
 *
 * Auth is not re-implemented here. The upgrade request is first run through
 * the Hono app as a plain GET of the same URL (same headers, same socket
 * address), so the tailnet/token/role rules in auth.ts and the per-agent
 * allowance in the route decide; only a 200 is upgraded.
 *
 * Wire format: text frames are JSON control messages from the server
 * (`init`, `error`, `end`), binary frames are terminal bytes. The client
 * sends nothing but pings; the view is read-only.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Hono } from 'hono';
import logger from './logger.js';
import type { NodeAppEnv } from './auth.js';
import { openPaneStream, type StreamHandle } from './terminal-stream.js';

export const TERMINAL_PATH = /^\/api\/agents\/([^/]+)\/terminal$/;
/** A viewer that cannot drain this much is cut off rather than buffered forever. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const PING_MS = 30_000;

export interface TerminalRouteInfo {
  enabled: boolean;
  session: string;
  cols: number;
  rows: number;
  history_size: number;
}

export function attachTerminalWs(server: Server, app: Pick<Hono<NodeAppEnv>, 'fetch'>): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head).catch((e) => {
      logger.warn({ error: (e as Error).message }, 'terminal upgrade failed');
      refuse(socket, 500, 'upgrade failed');
    });
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!TERMINAL_PATH.test(url.pathname)) {
      refuse(socket, 404, 'no such websocket endpoint');
      return;
    }

    const probe = new Request(url.toString(), { method: 'GET', headers: nodeHeaders(req) });
    const res = await app.fetch(probe, { incoming: req } as NodeAppEnv['Bindings']);
    if (res.status !== 200) {
      const text = await res.text().catch(() => '');
      refuse(socket, res.status, text || res.statusText);
      return;
    }
    const info = (await res.json()) as TerminalRouteInfo;
    if (!info.enabled) {
      refuse(socket, 404, 'terminal stream disabled');
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, info.session));
  }

  async function serve(ws: WebSocket, session: string): Promise<void> {
    let handle: StreamHandle | null = null;
    const send = (chunk: Buffer): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        logger.warn({ session }, 'terminal viewer too slow, closing');
        ws.close(1008, 'viewer too slow');
        return;
      }
      ws.send(chunk, { binary: true });
    };

    const opened = await openPaneStream(session, send);
    if (!opened.ok) {
      ws.send(JSON.stringify({ t: 'error', message: opened.error }));
      ws.close(1011, 'stream unavailable');
      return;
    }
    handle = opened.data;
    if (ws.readyState !== ws.OPEN) {
      handle.close();
      return;
    }
    const g = handle.geometry;
    ws.send(JSON.stringify({ t: 'init', session, cols: g.cols, rows: g.rows, history_size: g.history_size }));
    if (handle.seed.length > 0) ws.send(handle.seed, { binary: true });

    const ping = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
    }, PING_MS);
    ping.unref();

    ws.on('message', () => { /* read-only: client input is ignored */ });
    ws.on('close', () => {
      clearInterval(ping);
      handle?.close();
    });
    ws.on('error', (e) => logger.debug({ session, error: e.message }, 'terminal socket error'));
  }

  return wss;
}

function nodeHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  const text = reason.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const body = text || 'refused';
  socket.write(`HTTP/1.1 ${status} ${httpReason(status)}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  socket.destroy();
}

function httpReason(status: number): string {
  switch (status) {
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 500: return 'Internal Server Error';
    default: return 'Error';
  }
}
