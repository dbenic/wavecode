import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { getConfig } from '../config.js';

/** Diagram languages Kroki renders for us (Mermaid is rendered in the browser). */
export const KROKI_LANGS = new Set(['d2', 'plantuml', 'c4plantuml', 'graphviz', 'dot', 'erd', 'nomnoml', 'seqdiag', 'blockdiag', 'actdiag', 'ditaa', 'structurizr', 'excalidraw', 'svgbob', 'wavedrom', 'pikchr', 'dbml']);
const MAX_SOURCE = 64 * 1024;
const MAX_SVG = 3 * 1024 * 1024;

export function registerDiagramRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/diagrams/engines', (c) => {
    const kroki = getConfig().diagrams?.kroki_url ?? null;
    return c.json({ mermaid: 'browser', kroki: kroki ? [...KROKI_LANGS] : [] });
  });

  // Source text → SVG via the configured Kroki. The SVG is sanitized in the UI before it is shown.
  app.post('/api/diagrams/render', async (c) => {
    const kroki = getConfig().diagrams?.kroki_url;
    if (!kroki) return c.json({ error: 'No diagram renderer configured (diagrams.kroki_url)' }, 501);
    const body = await c.req.json<{ lang?: unknown; source?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const lang = typeof body.lang === 'string' ? body.lang.toLowerCase() : '';
    if (!KROKI_LANGS.has(lang)) return c.json({ error: `Unsupported diagram language '${lang}'` }, 400);
    if (typeof body.source !== 'string' || !body.source.trim()) return c.json({ error: 'source is required' }, 400);
    if (body.source.length > MAX_SOURCE) return c.json({ error: 'source too large' }, 413);
    const engine = lang === 'dot' ? 'graphviz' : lang;
    try {
      const res = await fetch(`${kroki.replace(/\/$/, '')}/${engine}/svg`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body.source, signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (!res.ok) return c.json({ error: `renderer: ${text.substring(0, 400) || res.statusText}` }, 422);
      if (text.length > MAX_SVG) return c.json({ error: 'rendered diagram too large' }, 413);
      return c.json({ svg: text });
    } catch (e) {
      return c.json({ error: `renderer unreachable: ${(e as Error).message}` }, 502);
    }
  });
}
