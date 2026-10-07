// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders a GFM table as a sanitized <table> and keeps prose around it', () => {
    const html = renderMarkdown([
      'Two items need your decision.',
      '',
      '| # | Work | Unblocks |',
      '| --- | --- | --- |',
      '| 5 | Non-EU supplier, no VAT ID | 21 |',
      '| 6 | DPD charged SI VAT | 2 |',
      '',
      '- Counts may overlap.',
    ].join('\n'));
    expect(html).toContain('<table');
    expect(html).toMatch(/<th[^>]*>Unblocks<\/th>/);
    expect(html).toMatch(/<td[^>]*>Non-EU supplier, no VAT ID<\/td>/);
    expect((html.match(/<tr/g) ?? []).length).toBe(3); // header + 2 rows
    expect(html).not.toContain('<br/><tr');          // table emitted on one line, never broken by <br/>
    expect(html).toContain('Two items need your decision.');
    expect(html).toMatch(/<li[^>]*>Counts may overlap\.<\/li>/);
  });

  it('never lets HTML through — cells and prose are escaped, scripts dropped', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| <img src=x onerror=alert(1)> | <script>x</script> |');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
  });
});

describe('diagram fences', () => {
  it('```mermaid / ```d2 blocks become marked <pre class="diagram diagram-<lang>"> with the escaped source; other fences stay code', async () => {
    const { renderMarkdown } = await import('./markdown');
    const out = renderMarkdown('Flow:\n\n```mermaid\nflowchart TD\n  A[Upload] --> B{Valid?}\n```\n\n```d2\nx -> y: hi\n```\n\n```ts\nconst a = 1;\n```');
    expect(out).toContain('<pre class="diagram diagram-mermaid text-[11px] text-slate-500">flowchart TD');
    expect(out).toContain('A[Upload] --&gt; B{Valid?}');
    expect(out).toContain('<pre class="diagram diagram-d2 text-[11px] text-slate-500">x -&gt; y: hi</pre>');
    expect(out).toMatch(/<pre class="bg-slate-900\/80[^"]*"><code>const a = 1;<\/code><\/pre>/);
  });
});
