import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const diagrams: { kroki_url?: string | null } = {};
vi.mock('../config.js', () => ({ getConfig: vi.fn(() => ({ diagrams })) }));

import { registerDiagramRoutes } from './diagrams.js';

let app: Hono;
beforeEach(() => { app = new Hono(); registerDiagramRoutes(app as never); diagrams.kroki_url = 'http://127.0.0.1:8000'; });
afterEach(() => vi.restoreAllMocks());

const post = (body: unknown) => app.request('/api/diagrams/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/diagrams/render', () => {
  it('forwards an allowed language to Kroki as text and returns the SVG', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { status: 200 }));
    const res = await post({ lang: 'd2', source: 'x -> y' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' });
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8000/d2/svg', expect.objectContaining({ method: 'POST', body: 'x -> y' }));
    // dot is an alias for graphviz
    await post({ lang: 'dot', source: 'digraph{a->b}' });
    expect(fetchSpy).toHaveBeenLastCalledWith('http://127.0.0.1:8000/graphviz/svg', expect.anything());
  });

  it('refuses unknown languages, empty or oversized sources, and reports renderer errors without a renderer configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await post({ lang: 'mermaid', source: 'x' })).status).toBe(400); // browser-side
    expect((await post({ lang: 'd2', source: '' })).status).toBe(400);
    expect((await post({ lang: 'd2', source: 'x'.repeat(70_000) })).status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValue(new Response('syntax error at line 1', { status: 400 }));
    const bad = await post({ lang: 'd2', source: '-> ->' });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toMatch(/syntax error/);
    diagrams.kroki_url = null;
    expect((await post({ lang: 'd2', source: 'x -> y' })).status).toBe(501);
  });
});
