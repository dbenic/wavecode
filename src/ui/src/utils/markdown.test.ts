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
