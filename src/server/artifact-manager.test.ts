import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  insertArtifact: vi.fn(),
  getArtifact: vi.fn(),
  listArtifacts: vi.fn(),
  listArtifactsForAgent: vi.fn(),
  findArtifactByHash: vi.fn(),
  insertArtifactTarget: vi.fn(),
  insertRunArtifact: vi.fn(),
  deleteArtifactTargets: vi.fn(),
  deleteArtifactTarget: vi.fn(),
  deleteRunArtifacts: vi.fn(),
  deleteArtifact: vi.fn(),
  countArtifactRefsForHash: vi.fn(),
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
  listArtifactsForAgent: dbMocks.listArtifactsForAgent,
  findArtifactByHash: dbMocks.findArtifactByHash,
  insertArtifactTarget: dbMocks.insertArtifactTarget,
  insertRunArtifact: dbMocks.insertRunArtifact,
  deleteArtifactTargets: dbMocks.deleteArtifactTargets,
  deleteArtifactTarget: dbMocks.deleteArtifactTarget,
  deleteRunArtifacts: dbMocks.deleteRunArtifacts,
  deleteArtifact: dbMocks.deleteArtifact,
  countArtifactRefsForHash: dbMocks.countArtifactRefsForHash,
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

  it('detaches an artifact from an agent without deleting the file', async () => {
    const artifactManager = await import('./artifact-manager.js');
    const storagePath = path.join(tempDir, 'storage', 'detach-test.md');
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, '# Test\n');

    dbMocks.getArtifact.mockReturnValue({
      ok: true,
      data: makeArtifact({
        id: 'artifact-d1',
        filename: 'detach-test.md',
        storage_path: storagePath,
        source_agent_id: 'agent-1',
      }),
    });

    const mockPrepare = vi.fn().mockReturnValue({ run: vi.fn() });
    dbMocks.getDb.mockReturnValue({ prepare: mockPrepare });

    const result = artifactManager.detachArtifactFromAgent('artifact-d1', 'agent-1');

    expect(result.ok).toBe(true);
    expect(dbMocks.deleteArtifactTarget).toHaveBeenCalledWith('artifact-d1', 'agent', 'agent-1');
    // source_agent_id matches, so it should be cleared
    expect(mockPrepare).toHaveBeenCalledWith('UPDATE artifacts SET source_agent_id = NULL WHERE id = ?');
    // File should still exist
    expect(fs.existsSync(storagePath)).toBe(true);
    expect(eventBusMocks.emit).toHaveBeenCalledWith(
      'artifact.detached',
      'artifact',
      'artifact-d1',
      expect.objectContaining({ agent_id: 'agent-1' }),
    );
  });

  it('detaches an artifact from a non-source agent without clearing source_agent_id', async () => {
    const artifactManager = await import('./artifact-manager.js');

    dbMocks.getArtifact.mockReturnValue({
      ok: true,
      data: makeArtifact({
        id: 'artifact-d2',
        filename: 'shared.md',
        source_agent_id: 'agent-original',
      }),
    });

    const mockPrepare = vi.fn().mockReturnValue({ run: vi.fn() });
    dbMocks.getDb.mockReturnValue({ prepare: mockPrepare });

    const result = artifactManager.detachArtifactFromAgent('artifact-d2', 'agent-other');

    expect(result.ok).toBe(true);
    expect(dbMocks.deleteArtifactTarget).toHaveBeenCalledWith('artifact-d2', 'agent', 'agent-other');
    // source_agent_id doesn't match, so UPDATE should NOT be called
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it('deletes an artifact and removes the file when no other refs exist', async () => {
    const artifactManager = await import('./artifact-manager.js');
    const storagePath = path.join(tempDir, 'storage', 'delete-me.md');
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, '# Delete me\n');

    dbMocks.getArtifact.mockReturnValue({
      ok: true,
      data: makeArtifact({
        id: 'artifact-del1',
        filename: 'delete-me.md',
        sha256: 'hash-unique',
        storage_path: storagePath,
      }),
    });
    dbMocks.countArtifactRefsForHash.mockReturnValue(0);

    const result = artifactManager.removeArtifact('artifact-del1');

    expect(result.ok).toBe(true);
    expect(dbMocks.deleteRunArtifacts).toHaveBeenCalledWith('artifact-del1');
    expect(dbMocks.deleteArtifactTargets).toHaveBeenCalledWith('artifact-del1');
    expect(dbMocks.deleteArtifact).toHaveBeenCalledWith('artifact-del1');
    expect(fs.existsSync(storagePath)).toBe(false);
    expect(eventBusMocks.emit).toHaveBeenCalledWith(
      'artifact.deleted',
      'artifact',
      'artifact-del1',
      expect.objectContaining({ filename: 'delete-me.md', sha256: 'hash-unique' }),
    );
  });

  it('deletes an artifact but preserves the file when other refs exist', async () => {
    const artifactManager = await import('./artifact-manager.js');
    const storagePath = path.join(tempDir, 'storage', 'shared-file.md');
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    fs.writeFileSync(storagePath, '# Shared content\n');

    dbMocks.getArtifact.mockReturnValue({
      ok: true,
      data: makeArtifact({
        id: 'artifact-del2',
        filename: 'shared-file.md',
        sha256: 'hash-shared',
        storage_path: storagePath,
      }),
    });
    dbMocks.countArtifactRefsForHash.mockReturnValue(2);

    const result = artifactManager.removeArtifact('artifact-del2');

    expect(result.ok).toBe(true);
    expect(dbMocks.deleteArtifact).toHaveBeenCalledWith('artifact-del2');
    // File should still exist since other artifacts reference the same hash
    expect(fs.existsSync(storagePath)).toBe(true);
  });

  it('returns error when deleting non-existent artifact', async () => {
    const artifactManager = await import('./artifact-manager.js');

    dbMocks.getArtifact.mockReturnValue({
      ok: false,
      error: 'Artifact not-exists not found',
    });

    const result = artifactManager.removeArtifact('not-exists');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not found');
  });

  it('getAgentArtifacts delegates to listArtifactsForAgent', async () => {
    const artifactManager = await import('./artifact-manager.js');
    const mockArtifacts = [makeArtifact({ id: 'a1' }), makeArtifact({ id: 'a2' })];
    dbMocks.listArtifactsForAgent.mockReturnValue(mockArtifacts);

    const result = artifactManager.getAgentArtifacts('agent-1');

    expect(dbMocks.listArtifactsForAgent).toHaveBeenCalledWith('agent-1');
    expect(result).toEqual(mockArtifacts);
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
