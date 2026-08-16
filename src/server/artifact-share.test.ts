/**
 * Operator share path: upload → attach/share → file is on disk in the
 * agent's workspace, and list_artifacts?agent_id= confirms it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

describe('artifact share path (upload → attach → workspace)', () => {
  let tmpDir: string;
  let workspace: string;
  let agentId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-artifact-share-'));
    workspace = path.join(tmpDir, 'agent-workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(configPath, `
server:
  port: 3777
  host: 127.0.0.1
paths:
  projects_root: ${tmpDir}/projects
  worktrees_root: ${tmpDir}/worktrees
  transcripts_root: ${tmpDir}/transcripts
  teams_root: ${tmpDir}/teams
  guides_root: ${tmpDir}/guides
  templates_root: ${tmpDir}/templates
artifacts:
  storage: ${tmpDir}/artifact-store
  retention_days: 30
auth:
  method: token
  fallback_token: test-token
  trusted_proxies: []
`.trimStart());

    const { loadConfig } = await import('./config.js');
    loadConfig(configPath);

    const db = await import('./db.js');
    db.initDb(path.join(tmpDir, 'test.db'));
    const agent = db.insertAgent({
      name: 'countixdev',
      runtime: 'codex',
      tmux_session: 'wc-countixdev',
      workspace,
      mode: 'spawned',
      status: 'idle',
    });
    expect(agent.ok).toBe(true);
    if (!agent.ok) throw new Error(agent.error);
    agentId = agent.data.id;
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upload with agent_id copies the file into the workspace and lists it', async () => {
    const app = await createApp();
    const spec = '# Incoming view spec\nImplement /incoming.\n';

    const upload = await app.fetch(new Request('http://localhost/api/artifacts/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'incoming-spec.md',
        content_base64: Buffer.from(spec).toString('base64'),
        agent_id: agentId,
        note: 'from CountixDev',
      }),
    }));

    expect(upload.status).toBe(201);
    const body = await upload.json() as {
      id: string;
      filename: string;
      attached_path: string;
    };
    expect(body.filename).toBe('incoming-spec.md');
    expect(body.attached_path).toBe(
      path.join(workspace, '.wavecode', 'artifacts', 'incoming-spec.md'),
    );
    expect(fs.existsSync(body.attached_path)).toBe(true);
    expect(fs.readFileSync(body.attached_path, 'utf-8')).toBe(spec);

    const listed = await app.fetch(
      new Request(`http://localhost/api/artifacts?agent_id=${agentId}`),
    );
    expect(listed.status).toBe(200);
    const artifacts = await listed.json() as Array<{ id: string; filename: string }>;
    expect(artifacts.some((a) => a.id === body.id && a.filename === 'incoming-spec.md')).toBe(true);

    const byName = await app.fetch(
      new Request('http://localhost/api/artifacts?agent_id=countixdev'),
    );
    const named = await byName.json() as Array<{ id: string }>;
    expect(named.some((a) => a.id === body.id)).toBe(true);
  });

  it('upload then share/attach lands the file so the CLI agent can open attached_path', async () => {
    const app = await createApp();
    const pdf = Buffer.from('%PDF-1.4 fake screenshot');

    const upload = await app.fetch(new Request('http://localhost/api/artifacts/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'screen.png',
        content_base64: pdf.toString('base64'),
      }),
    }));
    expect(upload.status).toBe(201);
    const stored = await upload.json() as { id: string; attached_path?: string };
    expect(stored.attached_path).toBeUndefined();

    const attach = await app.fetch(new Request(`http://localhost/api/artifacts/${stored.id}/attach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'countixdev' }),
    }));
    expect(attach.status).toBe(200);
    const attached = await attach.json() as { attached_path: string };
    expect(fs.existsSync(attached.attached_path)).toBe(true);
    expect(fs.readFileSync(attached.attached_path)).toEqual(pdf);

    const share = await app.fetch(new Request(`http://localhost/api/artifacts/${stored.id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    }));
    expect(share.status).toBe(200);
    const shared = await share.json() as { ok: true; attached_path: string; notified: boolean };
    expect(shared.ok).toBe(true);
    expect(fs.existsSync(shared.attached_path)).toBe(true);
    expect(shared.notified).toBe(false);

    const listed = await app.fetch(
      new Request(`http://localhost/api/artifacts?agent_id=${agentId}`),
    );
    const artifacts = await listed.json() as Array<{ id: string }>;
    expect(artifacts.some((a) => a.id === stored.id)).toBe(true);
  });
});

async function createApp() {
  const { registerArtifactRoutes } = await import('./routes/artifacts.js');
  const app = new Hono();
  registerArtifactRoutes(app);
  return app;
}
