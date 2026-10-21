import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const cfg = vi.hoisted(() => ({ test_portal: { url: 'http://countix-testing.tailf32df0.ts.net:8088', poll_s: 20 } as { url?: string; poll_s?: number } | undefined }));
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ test_portal: cfg.test_portal })) }));
vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./perf-monitor.js', () => ({ recordJob: vi.fn() }));

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'test-portal', 'sample.json'), 'utf8'));

describe('test portal', () => {
  beforeEach(async () => { vi.clearAllMocks(); const m = await import('./test-portal.js'); m.resetPortalForTest(); cfg.test_portal = { url: 'http://countix-testing.tailf32df0.ts.net:8088', poll_s: 20 }; });
  afterEach(async () => { const m = await import('./test-portal.js'); m.setPortalFetchForTest(null); });

  it('maps submitter labels to WaveCode agent names', async () => {
    const { agentNameOf } = await import('./test-portal.js');
    expect(agentNameOf('wave.countix-dev.claude5')).toBe('claude5');
    expect(agentNameOf('wave.countix-dev.ales-claude2')).toBe('ales-claude2');
    expect(agentNameOf('gate.fable')).toBeNull();
    expect(agentNameOf('')).toBeNull();
    expect(agentNameOf('unknown')).toBeNull();
  });

  it('polls the portal, keeps the contract fields, emits only on a material change, and backs off when unreachable', async () => {
    const m = await import('./test-portal.js');
    const bus = await import('./event-bus.js');
    let body: unknown = sample;
    let fail = false;
    m.setPortalFetchForTest((async () => {
      if (fail) throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    expect(await m.pollPortalOnce(1_000_000)).toBe(true);
    let s = m.portalState();
    expect(s.enabled).toBe(true);
    expect(s.host).toBe('countix-testing.tailf32df0.ts.net:8088');
    expect(s.doc?.runs).toHaveLength(4);
    expect(s.doc?.runners.map((r) => r.name)).toEqual(['runner-a', 'runner-b', 'runner-c', 'full-a']);
    expect(s.schema_ok).toBe(true);
    expect(s.error).toBeNull();
    expect(vi.mocked(bus.emit)).toHaveBeenCalledWith('tests.portal', 'system', 'test-portal', expect.objectContaining({ running: 4, runners: 4, unhealthy: 0 }), null);

    // elapsed ticking is not a change
    body = { ...sample, generated_at: '2026-10-21T11:43:42Z', runs: sample.runs.map((r: { elapsed_s: number }) => ({ ...r, elapsed_s: r.elapsed_s + 20 })) };
    expect(await m.pollPortalOnce(1_020_000)).toBe(false);
    expect(vi.mocked(bus.emit)).toHaveBeenCalledTimes(1);

    // a runner going unhealthy is
    body = { ...sample, runners: sample.runners.map((r: { name: string }, i: number) => (i === 0 ? { ...r, health: 'unhealthy', preflight: 'postgres-down' } : r)) };
    expect(await m.pollPortalOnce(1_040_000)).toBe(true);
    expect(vi.mocked(bus.emit)).toHaveBeenLastCalledWith('tests.portal', 'system', 'test-portal', expect.objectContaining({ unhealthy: 1 }), null);

    // unreachable: error kept, last doc kept, backoff grows 20 → 60 → 120, one event on the edge
    fail = true;
    expect(await m.pollPortalOnce(1_060_000)).toBe(false);
    s = m.portalState();
    expect(s.error).toBe('fetch failed');
    expect(s.doc?.runs).toHaveLength(4);
    expect(s.next_in_s).toBe(20);
    await m.pollPortalOnce(1_080_000);
    expect(m.portalState().next_in_s).toBe(60);
    await m.pollPortalOnce(1_140_000);
    expect(m.portalState().next_in_s).toBe(120);
    expect(vi.mocked(bus.emit).mock.calls.filter((c) => (c[3] as { unavailable?: boolean }).unavailable).length).toBe(1);

    // unknown schema is reported, not rejected
    fail = false;
    body = { ...sample, schema: 2 };
    await m.pollPortalOnce(1_300_000);
    expect(m.portalState().schema_ok).toBe(false);
    expect(m.portalState().error).toBeNull();
  });

  it('is hidden when no portal is configured', async () => {
    cfg.test_portal = undefined;
    const m = await import('./test-portal.js');
    expect(m.portalState().enabled).toBe(false);
    expect(await m.pollPortalOnce()).toBe(false);
  });
});
