/**
 * Tests for the docs route — focused on the POST /api/agents/:id/docs
 * endpoint that the QA agent uses to attach reports to an agent's docs.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../db.js', () => ({
  getAgent: vi.fn(),
  listAgents: vi.fn().mockReturnValue([]),
}));

describe('POST /api/agents/:id/docs', () => {
  let tmpDir: string;
  let workspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-docs-test-'));
    workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a markdown file into the agent workspace and returns the slug', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-42', name: 'qa-target', workspace },
    } as never);

    const app = await createDocsApp();
    const response = await app.fetch(
      new Request('http://localhost/api/agents/agent-42/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'qa-report.md',
          content: '# QA Report\n\nFindings: 3\n',
          subdir: 'qa-reports',
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json() as { ok: boolean; path: string; slug: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('qa-reports/qa-report.md');
    expect(body.slug).toContain('agent-42');
    expect(body.url).toBe(`/docs/${body.slug}`);

    const written = fs.readFileSync(path.join(workspace, 'qa-reports', 'qa-report.md'), 'utf-8');
    expect(written).toBe('# QA Report\n\nFindings: 3\n');
  });

  it('returns 404 when the agent does not exist', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAgent).mockReturnValue({ ok: false, error: 'not found' } as never);

    const app = await createDocsApp();
    const response = await app.fetch(
      new Request('http://localhost/api/agents/nope/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'x.md', content: 'hi' }),
      }),
    );

    expect(response.status).toBe(404);
  });

  it('returns 400 when the agent has no workspace', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-9', name: 'workspaceless', workspace: null },
    } as never);

    const app = await createDocsApp();
    const response = await app.fetch(
      new Request('http://localhost/api/agents/agent-9/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'x.md', content: 'hi' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects filenames that do not end in .md', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', name: 'a', workspace },
    } as never);

    const app = await createDocsApp();
    const response = await app.fetch(
      new Request('http://localhost/api/agents/agent-1/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'evil.sh', content: 'rm -rf /' }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('rejects subdirs containing path traversal', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', name: 'a', workspace },
    } as never);

    const app = await createDocsApp();
    const response = await app.fetch(
      new Request('http://localhost/api/agents/agent-1/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'note.md',
          content: '# escape',
          subdir: '../../../etc',
        }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it('sanitises odd filename characters before writing', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', name: 'a', workspace },
    } as never);

    const app = await createDocsApp();
    const response = await app.fetch(
      new Request('http://localhost/api/agents/agent-1/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'weird name with spaces & symbols!.md',
          content: '# ok',
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json() as { path: string };
    expect(body.path).toMatch(/weird_name_with_spaces___symbols_\.md$/);
  });
});

async function createDocsApp() {
  const { registerDocsRoutes } = await import('./docs.js');
  const app = new Hono();
  registerDocsRoutes(app);
  return app;
}
