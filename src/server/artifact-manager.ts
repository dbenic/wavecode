import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getDb,
  getAgent,
  insertArtifact,
  getArtifact,
  listArtifacts,
  listArtifactsForAgent,
  findArtifactByHash,
  insertArtifactTarget,
  insertRunArtifact,
  deleteArtifactTargets,
  deleteArtifactTarget,
  deleteRunArtifacts,
  deleteArtifact as dbDeleteArtifact,
  countArtifactRefsForHash,
  type Artifact,
  type Result,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import { sendKeys } from './session-manager.js';
import * as tmux from './tmux.js';
import { resolvePathWithinRoot } from './path-utils.js';

const MIME_MAP: Record<string, string> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.log': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
};

function detectMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function computeSha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function computeSha256FromBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function getStorageDir(): string {
  const config = getConfig();
  const dir = config.artifacts.storage;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeAttachmentFilename(filename: string): string {
  const sanitized = path.basename(filename)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return sanitized || 'attachment';
}

function ensureWavecodeGitignore(workspace: string): void {
  const gitignorePath = path.join(workspace, '.gitignore');
  const gitDir = path.join(workspace, '.git');
  if (!fs.existsSync(gitDir)) return;

  let gitignore = '';
  if (fs.existsSync(gitignorePath)) {
    gitignore = fs.readFileSync(gitignorePath, 'utf-8');
  }

  if (!gitignore.split('\n').some((line) => line.trim() === '.wavecode/' || line.trim() === '.wavecode')) {
    const prefix = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(gitignorePath, gitignore + prefix + '.wavecode/\n', 'utf-8');
  }
}

function resolveAgentWorkspace(targetAgentId: string): Result<string> {
  const agentResult = getAgent(targetAgentId);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const agent = agentResult.data;
  const workspace = agent.workspace ?? tmux.getPaneDir(agent.tmux_session);
  if (!workspace) {
    return { ok: false, error: `Agent '${agent.name}' has no workspace directory` };
  }

  return { ok: true, data: workspace };
}

function ensureAgentArtifactsDir(workspace: string): Result<string> {
  const artifactsDir = resolvePathWithinRoot(workspace, path.join('.wavecode', 'artifacts'));
  if (!artifactsDir) {
    return { ok: false, error: 'Invalid artifact attachment path' };
  }

  try {
    fs.mkdirSync(artifactsDir, { recursive: true });
    ensureWavecodeGitignore(workspace);
  } catch (e) {
    return { ok: false, error: `Failed to prepare agent artifact directory: ${(e as Error).message}` };
  }

  return { ok: true, data: artifactsDir };
}

function getAvailableAttachmentPath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext) || 'attachment';

  let candidate = path.join(dir, filename);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${suffix}${ext}`);
    suffix += 1;
  }

  return candidate;
}

function copyArtifactToAgentWorkspace(
  artifact: Artifact,
  targetAgentId: string,
): Result<{ attachedPath: string }> {
  if (!fs.existsSync(artifact.storage_path)) {
    return { ok: false, error: 'Artifact file not found on disk' };
  }

  const workspaceResult = resolveAgentWorkspace(targetAgentId);
  if (!workspaceResult.ok) return workspaceResult;

  const dirResult = ensureAgentArtifactsDir(workspaceResult.data);
  if (!dirResult.ok) return dirResult;

  const targetFilename = sanitizeAttachmentFilename(artifact.filename);
  const attachedPath = getAvailableAttachmentPath(dirResult.data, targetFilename);

  try {
    fs.copyFileSync(artifact.storage_path, attachedPath);
  } catch (e) {
    return { ok: false, error: `Failed to copy artifact into agent workspace: ${(e as Error).message}` };
  }

  insertArtifactTarget(artifact.id, 'agent', targetAgentId);

  return { ok: true, data: { attachedPath } };
}

/**
 * Store a file as an immutable artifact (copy-on-share).
 */
export function storeArtifact(opts: {
  sourcePath: string;
  filename?: string;
  sourceAgentId?: string;
  sourceRunId?: string;
  note?: string;
}): Result<Artifact> {
  if (!fs.existsSync(opts.sourcePath)) {
    return { ok: false, error: `Source file not found: ${opts.sourcePath}` };
  }

  const filename = opts.filename ?? path.basename(opts.sourcePath);
  const sha256 = computeSha256(opts.sourcePath);
  const stats = fs.statSync(opts.sourcePath);
  const mimeType = detectMime(filename);

  // Dedup: check if artifact with same hash already exists
  const existing = findArtifactByHash(sha256);
  if (existing) {
    return { ok: true, data: existing };
  }

  // Copy to content-addressed storage
  const storageDir = getStorageDir();
  const artifactDir = path.join(storageDir, sha256.substring(0, 8));
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  const storagePath = path.join(artifactDir, filename);
  fs.copyFileSync(opts.sourcePath, storagePath);

  const result = insertArtifact({
    filename,
    mime_type: mimeType,
    sha256,
    size_bytes: stats.size,
    storage_path: storagePath,
    preview_path: null,
    source_agent_id: opts.sourceAgentId ?? null,
    source_run_id: opts.sourceRunId ?? null,
    note: opts.note ?? null,
  });

  if (result.ok) {
    // Link to run if provided
    if (opts.sourceRunId) {
      insertRunArtifact(opts.sourceRunId, result.data.id, 'output');
    }

    emit('artifact.created', 'artifact', result.data.id, {
      filename,
      sha256,
      size_bytes: stats.size,
      source_agent_id: opts.sourceAgentId,
      source_run_id: opts.sourceRunId,
    });
  }

  return result;
}

/**
 * Store an artifact from a buffer (for uploads).
 */
export function storeArtifactFromBuffer(opts: {
  buffer: Buffer;
  filename: string;
  sourceAgentId?: string;
  sourceRunId?: string;
  note?: string;
}): Result<Artifact> {
  const sha256 = computeSha256FromBuffer(opts.buffer);
  const mimeType = detectMime(opts.filename);

  // Dedup
  const existing = findArtifactByHash(sha256);
  if (existing) {
    return { ok: true, data: existing };
  }

  // Write to storage
  const storageDir = getStorageDir();
  const artifactDir = path.join(storageDir, sha256.substring(0, 8));
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  const storagePath = path.join(artifactDir, opts.filename);
  fs.writeFileSync(storagePath, opts.buffer);

  const result = insertArtifact({
    filename: opts.filename,
    mime_type: mimeType,
    sha256,
    size_bytes: opts.buffer.length,
    storage_path: storagePath,
    preview_path: null,
    source_agent_id: opts.sourceAgentId ?? null,
    source_run_id: opts.sourceRunId ?? null,
    note: opts.note ?? null,
  });

  if (result.ok) {
    if (opts.sourceRunId) {
      insertRunArtifact(opts.sourceRunId, result.data.id, 'output');
    }

    emit('artifact.created', 'artifact', result.data.id, {
      filename: opts.filename,
      sha256,
      size_bytes: opts.buffer.length,
    });
  }

  return result;
}

/**
 * Attach an artifact to an agent by copying it into that agent's workspace.
 */
export function attachArtifactToAgent(
  artifactId: string,
  targetAgentId: string,
): Result<{ attachedPath: string }> {
  const artifactResult = getArtifact(artifactId);
  if (!artifactResult.ok) return { ok: false, error: artifactResult.error };

  const artifact = artifactResult.data;
  const attachResult = copyArtifactToAgentWorkspace(artifact, targetAgentId);
  if (!attachResult.ok) return attachResult;

  emit('artifact.shared', 'artifact', artifactId, {
    target_agent_id: targetAgentId,
    filename: artifact.filename,
    attached_path: attachResult.data.attachedPath,
  });

  return attachResult;
}

/**
 * Share an artifact with a target agent by copying to their worktree
 * and injecting a prompt.
 */
export function shareArtifact(
  artifactId: string,
  targetAgentId: string,
): Result<void> {
  const artifactResult = getArtifact(artifactId);
  if (!artifactResult.ok) return { ok: false, error: artifactResult.error };

  const artifact = artifactResult.data;
  const attachResult = copyArtifactToAgentWorkspace(artifact, targetAgentId);
  if (!attachResult.ok) return attachResult;

  // Inject prompt to target agent
  const promptText = `I've shared a file with you: "${artifact.filename}" (${formatBytes(artifact.size_bytes)}). It's copied into your workspace at: ${attachResult.data.attachedPath}. Please review it.`;

  const sendResult = sendKeys(targetAgentId, promptText);
  if (!sendResult.ok) {
    return { ok: false, error: `Failed to notify agent: ${sendResult.error}` };
  }

  emit('artifact.shared', 'artifact', artifactId, {
    target_agent_id: targetAgentId,
    filename: artifact.filename,
    attached_path: attachResult.data.attachedPath,
  });

  return { ok: true, data: undefined };
}

/**
 * Read the content of a text artifact.
 */
export function readArtifactContent(artifactId: string): Result<string> {
  const result = getArtifact(artifactId);
  if (!result.ok) return { ok: false, error: result.error };

  const artifact = result.data;
  if (!fs.existsSync(artifact.storage_path)) {
    return { ok: false, error: 'Artifact file not found on disk' };
  }

  if (!artifact.mime_type.startsWith('text/') && !artifact.mime_type.includes('json')) {
    return { ok: false, error: 'Artifact is not a text file' };
  }

  const content = fs.readFileSync(artifact.storage_path, 'utf-8');
  return { ok: true, data: content };
}

/**
 * Get all artifacts associated with an agent (created by OR shared to).
 */
export function getAgentArtifacts(agentId: string): Artifact[] {
  return listArtifactsForAgent(agentId);
}

/**
 * Detach an artifact from an agent without deleting the artifact.
 * Removes the artifact_target link and clears source_agent_id if it matches.
 */
export function detachArtifactFromAgent(
  artifactId: string,
  agentId: string,
): Result<void> {
  const artifactResult = getArtifact(artifactId);
  if (!artifactResult.ok) return { ok: false, error: artifactResult.error };

  // Remove the artifact_target link
  deleteArtifactTarget(artifactId, 'agent', agentId);

  // If this agent was the source, clear source_agent_id
  const artifact = artifactResult.data;
  if (artifact.source_agent_id === agentId) {
    getDb().prepare('UPDATE artifacts SET source_agent_id = NULL WHERE id = ?').run(artifactId);
  }

  emit('artifact.detached', 'artifact', artifactId, {
    agent_id: agentId,
    filename: artifact.filename,
  });

  return { ok: true, data: undefined };
}

/**
 * Delete an artifact entirely — removes DB records and file from disk.
 */
export function removeArtifact(artifactId: string): Result<void> {
  const artifactResult = getArtifact(artifactId);
  if (!artifactResult.ok) return { ok: false, error: artifactResult.error };

  const artifact = artifactResult.data;

  // Remove all DB references
  deleteRunArtifacts(artifactId);
  deleteArtifactTargets(artifactId);
  dbDeleteArtifact(artifactId);

  // Only delete file if no other artifact references the same hash
  const otherRefs = countArtifactRefsForHash(artifact.sha256, artifactId);
  if (otherRefs === 0 && fs.existsSync(artifact.storage_path)) {
    fs.unlinkSync(artifact.storage_path);
    // Clean up empty directory
    const dir = path.dirname(artifact.storage_path);
    try {
      const files = fs.readdirSync(dir);
      if (files.length === 0) fs.rmdirSync(dir);
    } catch { /* ignore */ }
  }

  emit('artifact.deleted', 'artifact', artifactId, {
    filename: artifact.filename,
    sha256: artifact.sha256,
  });

  return { ok: true, data: undefined };
}

/**
 * Prune artifacts older than retention_days.
 * Respects sha256 dedup — only deletes files not referenced by other artifacts.
 */
export function pruneOldArtifacts(): number {
  const config = getConfig();
  const retentionDays = config.artifacts.retention_days;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .split('.')[0];

  const db = getDb();

  const oldArtifacts = db.prepare(
    'SELECT * FROM artifacts WHERE created_at < ?'
  ).all(cutoff) as import('./db.js').Artifact[];

  let pruned = 0;
  for (const artifact of oldArtifacts) {
    // Check if any other artifact references the same hash
    const otherRefs = db.prepare(
      'SELECT COUNT(*) as cnt FROM artifacts WHERE sha256 = ? AND id != ?'
    ).get(artifact.sha256, artifact.id) as { cnt: number };

    // Delete the DB record
    db.prepare('DELETE FROM run_artifacts WHERE artifact_id = ?').run(artifact.id);
    db.prepare('DELETE FROM artifact_targets WHERE artifact_id = ?').run(artifact.id);
    db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifact.id);

    // Only delete the file if no other artifact uses the same hash
    if (otherRefs.cnt === 0 && fs.existsSync(artifact.storage_path)) {
      fs.unlinkSync(artifact.storage_path);
      // Clean up empty directory
      const dir = path.dirname(artifact.storage_path);
      try {
        const files = fs.readdirSync(dir);
        if (files.length === 0) fs.rmdirSync(dir);
      } catch { /* ignore */ }
    }

    pruned++;
  }

  return pruned;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
