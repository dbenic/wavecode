import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROBE_URL, probeUrl } from './probe.js';

describe('probeUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns status and url on mocked 200', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));

    const result = await probeUrl('https://example.test/get', { fetchImpl });

    expect(result).toEqual({
      ok: true,
      data: { status: 200, url: 'https://example.test/get' },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://example.test/get', { method: 'GET' });
  });

  it('fails on mocked 503', async () => {
    const fetchImpl = vi.fn(async () => new Response('unavailable', { status: 503 }));

    const result = await probeUrl('https://example.test/get', { fetchImpl });

    expect(result).toEqual({ ok: false, error: 'HTTP 503' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects non-http(s) URLs such as ftp', async () => {
    const fetchImpl = vi.fn();

    const result = await probeUrl('ftp://example.test/file', { fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/http\(s\)/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('live GET against a public endpoint', async () => {
    // Live check: prefer https://httpbin.org/get (DEFAULT_PROBE_URL).
    // If httpbin is 503, fall back to https://jsonplaceholder.typicode.com/todos/1.
    const fallbackUrl = 'https://jsonplaceholder.typicode.com/todos/1';

    let result = await probeUrl(DEFAULT_PROBE_URL);
    if (!result.ok && result.error.includes('503')) {
      result = await probeUrl(fallbackUrl);
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBeGreaterThanOrEqual(200);
    expect(result.data.status).toBeLessThan(300);
    expect(result.data.url === DEFAULT_PROBE_URL || result.data.url === fallbackUrl).toBe(true);
  });
});
