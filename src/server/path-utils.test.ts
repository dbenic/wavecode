import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentDocSlug, createLegacyAgentDocSlug, createRootDocSlug } from './doc-slugs.js';
import { resolvePathWithinRoot } from './path-utils.js';

describe('resolvePathWithinRoot', () => {
  it('resolves nested paths inside the root', () => {
    expect(resolvePathWithinRoot('/tmp/project', 'docs/readme.md')).toBe(
      path.resolve('/tmp/project/docs/readme.md'),
    );
  });

  it('rejects traversal into sibling paths that share the same prefix', () => {
    expect(resolvePathWithinRoot('/tmp/project', '../../project-secret/.env')).toBeNull();
  });
});

describe('doc slug helpers', () => {
  it('keeps root doc slugs stable', () => {
    expect(createRootDocSlug('docs/release-notes.md')).toBe('release-notes');
    expect(createRootDocSlug('CLAUDE.md')).toBe('claude-md');
  });

  it('uses the full relative path for agent doc slugs to avoid collisions', () => {
    expect(createAgentDocSlug('agent-1', 'notes/api.md')).toBe('agent-agent-1-notes-api');
    expect(createAgentDocSlug('agent-1', 'docs/api.md')).toBe('agent-agent-1-docs-api');
    expect(createAgentDocSlug('agent-1', 'notes/api.md')).not.toBe(
      createAgentDocSlug('agent-1', 'docs/api.md'),
    );
  });

  it('preserves the legacy basename-only slug for backwards compatibility lookups', () => {
    expect(createLegacyAgentDocSlug('agent-1', 'docs/api.md')).toBe('agent-agent-1-api');
  });
});
