// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createAgentDocSlug, createRootDocSlug } from './docs';
import { renderMarkdown } from './markdown';

describe('doc slug helpers', () => {
  it('keeps agent doc slugs unique across folders', () => {
    expect(createAgentDocSlug('agent-1', 'notes/api.md')).toBe('agent-agent-1-notes-api');
    expect(createAgentDocSlug('agent-1', 'docs/api.md')).toBe('agent-agent-1-docs-api');
    expect(createAgentDocSlug('agent-1', 'notes/api.md')).not.toBe(
      createAgentDocSlug('agent-1', 'docs/api.md'),
    );
  });

  it('keeps root doc slugs compatible with existing routes', () => {
    expect(createRootDocSlug('docs/release-notes.md')).toBe('release-notes');
    expect(createRootDocSlug('CLAUDE.md')).toBe('claude-md');
  });
});

describe('renderMarkdown', () => {
  it('preserves safe links', () => {
    const html = renderMarkdown('[docs](https://example.com/docs)');
    expect(html).toContain('href="https://example.com/docs"');
  });

  it('strips dangerous javascript links before rendering', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:alert(1)');
  });
});
