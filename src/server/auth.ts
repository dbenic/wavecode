import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { MiddlewareHandler } from 'hono';
import { getConfig, type WaveConfig } from './config.js';

export interface NodeAppBindings {
  incoming?: IncomingMessage | Http2ServerRequest | {
    socket?: { remoteAddress?: string };
  };
  outgoing?: ServerResponse | Http2ServerResponse | unknown;
}

export interface NodeAppEnv {
  Bindings: NodeAppBindings;
}

export interface PublicAuthStatus {
  method: WaveConfig['auth']['method'];
  tokenConfigured: boolean;
}

export function getPublicAuthStatus(config: WaveConfig): PublicAuthStatus {
  return {
    method: config.auth.method,
    tokenConfigured: !!config.auth.fallback_token,
  };
}

export function normalizeIp(rawIp: string | null | undefined): string | null {
  if (!rawIp) return null;

  let ip = rawIp.trim();
  if (!ip) return null;

  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice('::ffff:'.length);
  }

  ip = ip.replace(/%.+$/, '');

  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.replace(/:\d+$/, '');
  }

  return ip;
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === 'local';
}

export function isPrivateOrTailnetIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;

  return isLoopback(normalized)
    || normalized.startsWith('100.')
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
    || normalized.startsWith('fd7a:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd');
}

export function isTrustedProxyIp(ip: string | null | undefined, trustedProxies: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;

  return trustedProxies.some((candidate) => {
    const entry = candidate.trim();
    if (!entry) return false;
    if (entry === 'loopback') return isLoopback(normalized);
    return normalizeIp(entry) === normalized;
  });
}

export function parseForwardedFor(headerValue: string | null | undefined): string[] {
  if (!headerValue) return [];

  return headerValue
    .split(',')
    .map((part) => normalizeIp(part))
    .filter((part): part is string => !!part);
}

export function resolveSocketIp(bindings: NodeAppBindings): string {
  return normalizeIp(bindings.incoming?.socket?.remoteAddress) ?? 'local';
}

export function resolveClientIp(
  bindings: NodeAppBindings,
  headers: Headers,
  trustedProxies: string[],
): string {
  const socketIp = resolveSocketIp(bindings);

  if (!isTrustedProxyIp(socketIp, trustedProxies)) {
    return socketIp;
  }

  const forwardedChain = parseForwardedFor(headers.get('X-Forwarded-For'));
  if (forwardedChain.length > 0) {
    return forwardedChain[0];
  }

  return normalizeIp(headers.get('X-Real-IP')) ?? socketIp;
}

export function resolveRequestToken(pathname: string, headers: Headers, queryToken?: string | null): string | null {
  const authHeader = headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  if (pathname === '/api/events') {
    return queryToken?.trim() || null;
  }

  return null;
}

function hasForwardingHeaders(headers: Headers): boolean {
  return parseForwardedFor(headers.get('X-Forwarded-For')).length > 0
    || normalizeIp(headers.get('X-Real-IP')) !== null;
}

export function createAuthMiddleware(
  getConfigFn: () => WaveConfig = getConfig,
): MiddlewareHandler<NodeAppEnv> {
  return async (c, next) => {
    if (c.req.path === '/api/auth/status') {
      await next();
      return;
    }

    const config = getConfigFn();
    const expectedToken = config.auth.fallback_token;
    const token = resolveRequestToken(c.req.path, c.req.raw.headers, c.req.query('access_token'));

    if (expectedToken && token === expectedToken) {
      await next();
      return;
    }

    if (config.auth.method === 'token') {
      if (!expectedToken) {
        return c.json({ error: 'Token auth is enabled but no fallback token is configured' }, 500);
      }
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const socketIp = resolveSocketIp(c.env);
    const proxyTrusted = isTrustedProxyIp(socketIp, config.auth.trusted_proxies);
    if (!proxyTrusted && hasForwardingHeaders(c.req.raw.headers)) {
      return c.json({ error: 'Unauthorized: untrusted proxy' }, 401);
    }

    const clientIp = proxyTrusted
      ? resolveClientIp(c.env, c.req.raw.headers, config.auth.trusted_proxies)
      : socketIp;
    if (!isPrivateOrTailnetIp(clientIp)) {
      return c.json({ error: 'Unauthorized: not on tailnet' }, 401);
    }

    await next();
  };
}
