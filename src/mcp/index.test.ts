import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/config.js', () => ({
  getConfig: vi.fn(() => ({
    server: { port: 3777, host: '0.0.0.0' },
    auth: { fallback_token: 'config-fallback-token' },
  })),
}));

import { createMcpClient } from './index.js';

describe('createMcpClient', () => {
  beforeEach(() => {
    delete process.env.WAVECODE_URL;
    delete process.env.WAVECODE_TOKEN;
  });

  afterEach(() => {
    delete process.env.WAVECODE_URL;
    delete process.env.WAVECODE_TOKEN;
  });

  it('picks up config fallback_token when env and flags are unset', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization)
        .toBe('Bearer config-fallback-token');
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const client = createMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.get('/agents');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:3777/api/agents');
  });

  it('lets WAVECODE_TOKEN override the config token', async () => {
    process.env.WAVECODE_TOKEN = 'env-token';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization)
        .toBe('Bearer env-token');
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const client = createMcpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.get('/agents');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets --token override env and config', async () => {
    process.env.WAVECODE_TOKEN = 'env-token';
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization)
        .toBe('Bearer flag-token');
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const client = createMcpClient({
      token: 'flag-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.get('/agents');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
