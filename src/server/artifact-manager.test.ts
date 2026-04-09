import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  insertArtifact: vi.fn(),
  getArtifact: vi.fn(),
  listArtifacts: vi.fn(),
  findArtifactByHash: vi.fn(),
  insertArtifactTarget: vi.fn(),
  insertRunArtifact: vi.fn(),
  getAgent: vi.fn(),
}));

const sessionManagerMocks = vi.hoisted(() => ({
  sendKeys: vi.fn(),
}));

const tmuxMocks = vi.hoisted(() => ({
  getPaneDir: vi.fn(),
}));

const eventBusMocks = vi.hoisted(() => ({
  emit: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getDb: dbMocks.getDb,
  insertArtifact: dbMocks.insertArtifact,
  getArtifact: dbMocks.getArtifact,
  listArtifacts: dbMocks.listArtifacts,
  findArtifactByHash: dbMocks.findArtifactByHash,
  insertArtifactTarget: dbMocks.insertArtifactTarget,
  insertRunArtifact: dbMocks.insertRunArtifact,
  getAgent: dbMocks.getAgent,
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    artifacts: {
      storage: '/tmp/wavecode-artifacts',
      retention_days: 30,
    },
  })),
}));

vi.mock('./session-manager.js', () => ({
  sendKeys: sessionManagerMocks.sendKeys,
}));

vi.mock('./tmux.js', () => ({
  getPaneDir: tmuxMocks.getPaneDir,
}));

vi.mock('./event-bus.js', () => ({
  emit: eventBusMocks.emit,
}));

describe('artifact-manager.ts', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-artifact-manager-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('attaches an artifact into a spawned agent workspace', async () => {
    const artifactManager = await import('./artifact-manager.js');
    const storagePath = path.join(tempDir, 'storage', 'brief.md');
    const workspace = path.join(tempDir, 'workspace');

    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(storagePath, '# Brief\n');

    dbMocks.getArtifact.mockReturnValue({
      ok: true,
      data: makeArtifact({
        id: 'artifact-1',
        filename: 'brief.md',
        storage_path: storagePath,
        size_bytes: 8,
      }),
    });
    dbMocks.getAgent.mockReturnValue({
      ok: true,
      data: makeAgent({
        id: 'agent-1',
        name: 'builder',
        workspace,
      }),
    });

    const result = artifactManager.attachArtifactToAgent('artifact-1', 'agent-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attachedPath = path.join(workspace, '.wavecode', 'artifacts', 'brief.md');
    expect(result.data.attachedPath).toBe(attachedPath);
    expect(fs.readFileSync(attachedPath, 'utf-8')).toBe('# Brief\n');
    expect(dbMocks.insertArtifactTarget).toHaveBeenCalledWith('artifact-1', 'agent', 'agent-1');
    expect(eventBusMocks.emit).toHaveBeenCalledWith(
      'artifact.shared',
      'artifact',
      'artifact-1',
      expect.objectContaining({
        target_agent_id: 'agent-1',
        attached_path: attachedPath,
      }),
    );
  });

  it('shares an artifact into an adopted agent pane directory and notifies with the copied path', async () => {
    const artifactManager = await import('./artifact-manager.js');
    const storagePath = path.join(tempDir, 'storage', 'review notes.md');
    const paneDir = path.join(tempDir, 'adopted-pane');

    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.mkdirSync(paneDir, { recursive: true });
    fs.writeFileSync(storagePath, 'Looks good.\n');

    dbMocks.getArtifact.mockReturnValue({
      ok: true,
      data: makeArtifact({
        id: 'artifact-2',
        filename: 'review notes.md',
        storage_path: storagePath,
        size_bytes: 12,
      }),
    });
    dbMocks.getAgent.mockReturnValue({
      ok: true,
      data: makeAgent({
        id: 'agent-2',
        name: 'reviewer',
        tmux_session: 'legacy-reviewer',
        workspace: null,
        mode: 'adopted',
      }),
    });
    tmuxMocks.getPaneDir.mockReturnValue(paneDir);
    sessionManagerMocks.sendKeys.mockReturnValue({ ok: true, data: undefined });

    const result = artifactManager.shareArtifact('artifact-2', 'agent-2');

    expect(result.ok).toBe(true);
    const attachedPath = path.join(paneDir, '.wavecode', 'artifacts', 'review-notes.md');
    expect(fs.readFileSync(attachedPath, 'utf-8')).toBe('Looks good.\n');
    expect(sessionManagerMocks.sendKeys).toHaveBeenCalledWith(
      'agent-2',
      expect.stringContaining(attachedPath),
    );
    expect(sessionManagerMocks.sendKeys).not.toHaveBeenCalledWith(
      'agent-2',
      expect.stringContaining(storagePath),
    );
    expect(eventBusMocks.emit).toHaveBeenCalledWith(
      'artifact.shared',
      'artifact',
      'artifact-2',
      expect.objectContaining({
        target_agent_id: 'agent-2',
        attached_path: attachedPath,
      }),
    );
  });
});

function makeArtifact(overrides: Partial<{
  id: string;
  filename: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  storage_path: string;
  preview_path: string | null;
  source_agent_id: string | null;
  source_run_id: string | null;
  note: string | null;
  created_at: string;
}> = {}) {
  return {
    id: 'artifact-1',
    filename: 'artifact.txt',
    mime_type: 'text/plain',
    sha256: 'abc123',
    size_bytes: 0,
    storage_path: '/tmp/artifact.txt',
    preview_path: null,
    source_agent_id: null,
    source_run_id: null,
    note: null,
    created_at: '2026-04-09T00:00:00Z',
    ...overrides,
  };
}

function makeAgent(overrides: Partial<{
  id: string;
  name: string;
  runtime: string;
  tmux_session: string;
  workspace: string | null;
  mode: 'spawned' | 'adopted';
  status: 'idle' | 'working' | 'error';
  created_at: string;
}> = {}) {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'codex',
    tmux_session: 'wc-builder',
    workspace: '/tmp/workspace',
    mode: 'spawned' as const,
    status: 'idle' as const,
    created_at: '2026-04-09T00:00:00Z',
    ...overrides,
  };
}
