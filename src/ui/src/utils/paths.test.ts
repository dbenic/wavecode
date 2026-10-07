// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fileViewHref, linkifyPathsHtml } from './paths';
import { renderMarkdown } from './markdown';

describe('path links', () => {
  it('turns absolute and ~/ paths with a text extension into viewer links, leaving everything else alone', () => {
    const html = linkifyPathsHtml('see /home/ci/inbox/codex1-proposal-20261003.md and ~/notes/a.txt or /usr/bin/node and v1.0.2/x');
    expect(html).toContain(`<a href="${fileViewHref('/home/ci/inbox/codex1-proposal-20261003.md')}"`);
    expect(html).toContain(`<a href="${fileViewHref('~/notes/a.txt')}"`);
    expect(html).not.toContain('href="/file?path=%2Fusr%2Fbin%2Fnode"');
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it('does not touch paths inside existing anchors or attribute values', () => {
    const html = linkifyPathsHtml('<a href="https://x.com/docs/a.md" target="_blank">/home/x/readme.md</a> then /home/y/b.md');
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain(`<a href="${fileViewHref('/home/y/b.md')}"`);
    expect(html).not.toContain('<a href="https://x.com/docs/a.md" target="_blank"><a');
  });

  it('renderMarkdown links paths (in prose and in backticks) in-app, with no new tab; external links still open a tab', () => {
    const out = renderMarkdown('Report at `/home/wave/.wavecode-data/rooms/wavepulse/REPORTS/r.md`. See [docs](https://example.com/a).\nAlso ~/inbox/p.md');
    expect(out).toContain(`href="${fileViewHref('/home/wave/.wavecode-data/rooms/wavepulse/REPORTS/r.md')}"`);
    expect(out).toContain(`href="${fileViewHref('~/inbox/p.md')}"`);
    const internal = out.match(/<a href="\/file[^>]*>/g) ?? [];
    expect(internal).toHaveLength(2);
    for (const a of internal) expect(a).not.toContain('target=');
    expect(out).toMatch(/<a href="https:\/\/example\.com\/a"[^>]*target="_blank"/);
  });
});

describe('diagram source recovery', () => {
  it('rebuilds newlines from <br> and decodes entities so Mermaid gets the block as written', async () => {
    const { renderMarkdown } = await import('./markdown');
    const { diagramSourceFromHtml } = await import('./diagrams');
    const md = '```mermaid\nflowchart LR\n  UI[Chat] -->|question| GW[Gateway]\n  GW --> RT[src/server/advisor]\n```';
    const html = renderMarkdown(md);
    const pre = /<pre class="diagram diagram-mermaid[^"]*">([\s\S]*?)<\/pre>/.exec(html)![1];
    expect(diagramSourceFromHtml(pre)).toBe('flowchart LR\n  UI[Chat] -->|question| GW[Gateway]\n  GW --> RT[src/server/advisor]');
  });
});
