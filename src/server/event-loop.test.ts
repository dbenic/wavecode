import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { eventLoopLag, resetEventLoopMonitorForTest, sampleEventLoopForTest, startEventLoopMonitor } from './event-loop.js';
import logger from './logger.js';
import { registerHealthRoutes } from './routes/health.js';

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('event loop lag', () => {
  it('reports p99 and max on /api/health', async () => {
    resetEventLoopMonitorForTest();
    startEventLoopMonitor();
    const lag = eventLoopLag();
    expect(lag.p99_ms).toBeGreaterThanOrEqual(0);
    expect(lag.max_ms).toBeGreaterThanOrEqual(0);

    const app = new Hono();
    registerHealthRoutes(app);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { event_loop: { p99_ms: number; max_ms: number } };
    expect(body.event_loop.p99_ms).toBeGreaterThanOrEqual(0);
    expect(body.event_loop.max_ms).toBeGreaterThanOrEqual(0);
    resetEventLoopMonitorForTest();
  });

  it('warns when a sample max exceeds 200 ms', async () => {
    resetEventLoopMonitorForTest();
    vi.mocked(logger.warn).mockClear();
    startEventLoopMonitor();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const started = Date.now();
    while (Date.now() - started < 250) { /* a synchronous stall, the kind sync exec causes */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
    sampleEventLoopForTest();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ max_ms: expect.any(Number), p99_ms: expect.any(Number) }),
      'Event loop lag',
    );
    const logged = vi.mocked(logger.warn).mock.calls.find((call) => call[1] === 'Event loop lag');
    expect((logged?.[0] as { max_ms: number }).max_ms).toBeGreaterThan(200);
    resetEventLoopMonitorForTest();
  });
});
