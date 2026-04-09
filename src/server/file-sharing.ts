import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, generateId, getAgent, type Result } from './db.js';
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import * as tmux from './tmux.js';
import logger from './logger.js';

// --- Types ---

export interface SharedFile {
  id: string;
  filename: string;
  version: number;
  from_agent_id: string;
  from_agent_name: string;
  to_agent_id: string;
  to_agent_name: string;
  category: 'spec' | 'review' | 'context' | 'output';
  purpose: string;
  source_path: string;
  target_path: string;
  created_at: string;
}

// --- DB ---

export function ensureFileSharingTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS shared_files (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      from_agent_id TEXT NOT NULL,
      from_agent_name TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      to_agent_name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'spec',
      purpose TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// --- Get agent working directory ---

function getAgentDir(agentId: string): string | null {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return null;
  return tmux.getPaneDir(agentResult.data.tmux_session);
}

// --- Ensure .wavecode directory in agent's project ---

function ensureWavecodeDir(projectDir: string): string {
  const wcDir = path.join(projectDir, '.wavecode');
  const specsDir = path.join(wcDir, 'shared-specs');
  const reviewsDir = path.join(wcDir, 'shared-reviews');
  const contextDir = path.join(wcDir, 'shared-context');

  for (const dir of [wcDir, specsDir, reviewsDir, contextDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  return wcDir;
}

// --- Update the manifest (shared.md) ---

function updateManifest(projectDir: string, agentId: string): void {
  const wcDir = path.join(projectDir, '.wavecode');
  const manifestPath = path.join(wcDir, 'shared.md');

  // Get all shared files for this agent
  const files = getDb().prepare(
    'SELECT * FROM shared_files WHERE to_agent_id = ? ORDER BY created_at DESC'
  ).all(agentId) as SharedFile[];

  const specs = files.filter((f) => f.category === 'spec');
  const reviews = files.filter((f) => f.category === 'review');
  const context = files.filter((f) => f.category === 'context');
  const outputs = files.filter((f) => f.category === 'output');

  let md = `# Shared Files (managed by WaveCode)\n\nThis directory contains files shared with you by other agents.\nRead this file to see what's available and what you should do with each file.\n\n`;

  if (specs.length > 0) {
    md += `## Specifications\n`;
    for (const f of specs) {
      const relPath = path.relative(projectDir, f.target_path);
      md += `- **${relPath}** (v${f.version}, from ${f.from_agent_name}, ${f.created_at.split(' ')[0]})\n`;
      md += `  ${f.purpose}\n\n`;
    }
  }

  if (reviews.length > 0) {
    md += `## Reviews\n`;
    for (const f of reviews) {
      const relPath = path.relative(projectDir, f.target_path);
      md += `- **${relPath}** (from ${f.from_agent_name}, ${f.created_at.split(' ')[0]})\n`;
      md += `  ${f.purpose}\n\n`;
    }
  }

  if (context.length > 0) {
    md += `## Context\n`;
    for (const f of context) {
      const relPath = path.relative(projectDir, f.target_path);
      md += `- **${relPath}** (from ${f.from_agent_name})\n`;
      md += `  ${f.purpose}\n\n`;
    }
  }

  if (outputs.length > 0) {
    md += `## Outputs\n`;
    for (const f of outputs) {
      const relPath = path.relative(projectDir, f.target_path);
      md += `- **${relPath}** (from ${f.from_agent_name})\n`;
      md += `  ${f.purpose}\n\n`;
    }
  }

  fs.writeFileSync(manifestPath, md);
}

// --- Share a file between agents ---

export function shareFile(opts: {
  fromAgentId: string;
  toAgentId: string;
  filePath: string;        // relative or absolute path to the file
  category: 'spec' | 'review' | 'context' | 'output';
  purpose: string;
}): Result<SharedFile> {
  const fromAgent = getAgent(opts.fromAgentId);
  if (!fromAgent.ok) return { ok: false, error: `Source agent: ${fromAgent.error}` };

  const toAgent = getAgent(opts.toAgentId);
  if (!toAgent.ok) return { ok: false, error: `Target agent: ${toAgent.error}` };

  // Resolve source file path
  let sourcePath = opts.filePath;
  if (!sourcePath.startsWith('/')) {
    const fromDir = getAgentDir(opts.fromAgentId);
    if (fromDir) sourcePath = path.join(fromDir, sourcePath);
  }
  sourcePath = sourcePath.replace(/^~/, os.homedir());

  if (!fs.existsSync(sourcePath)) {
    return { ok: false, error: `File not found: ${sourcePath}` };
  }

  // Get target agent's project directory
  const toDir = getAgentDir(opts.toAgentId);
  if (!toDir) return { ok: false, error: `Cannot determine ${toAgent.data.name}'s working directory` };

  // Ensure .wavecode directory
  const wcDir = ensureWavecodeDir(toDir);

  // Determine target subdirectory
  const subDir = opts.category === 'spec' ? 'shared-specs'
    : opts.category === 'review' ? 'shared-reviews'
    : 'shared-context';

  const filename = path.basename(sourcePath);

  // Check for existing versions
  const existing = getDb().prepare(
    'SELECT * FROM shared_files WHERE to_agent_id = ? AND filename = ? ORDER BY version DESC LIMIT 1'
  ).get(opts.toAgentId, filename) as SharedFile | undefined;

  const version = existing ? existing.version + 1 : 1;

  // If updating, rename old file to .vN
  if (existing && fs.existsSync(existing.target_path)) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const versionedName = `${base}.v${existing.version}${ext}`;
    const versionedPath = path.join(path.dirname(existing.target_path), versionedName);
    fs.renameSync(existing.target_path, versionedPath);
  }

  // Copy file to target
  const targetPath = path.join(wcDir, subDir, filename);
  fs.copyFileSync(sourcePath, targetPath);

  // Record in DB
  const id = generateId();
  getDb().prepare(`
    INSERT INTO shared_files (id, filename, version, from_agent_id, from_agent_name, to_agent_id, to_agent_name, category, purpose, source_path, target_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, filename, version, opts.fromAgentId, fromAgent.data.name, opts.toAgentId, toAgent.data.name, opts.category, opts.purpose, sourcePath, targetPath);

  // Update manifest
  updateManifest(toDir, opts.toAgentId);

  // Notify the target agent
  const relPath = path.relative(toDir, targetPath);
  const manifestRelPath = '.wavecode/shared.md';
  const versionNote = version > 1 ? ` (updated to v${version}, previous version saved as .v${version - 1})` : '';

  sessionManager.sendKeys(opts.toAgentId,
    `A file has been shared with you from ${fromAgent.data.name}${versionNote}. Read .wavecode/shared.md for the full list of shared files. The new file is at: ${relPath}. ${opts.purpose}`
  );

  emit('file.shared', 'agent', opts.toAgentId, {
    filename,
    version,
    from: fromAgent.data.name,
    category: opts.category,
  });

  logger.info({
    from: fromAgent.data.name,
    to: toAgent.data.name,
    file: filename,
    version,
    category: opts.category,
  }, 'File shared between agents');

  const record = getDb().prepare('SELECT * FROM shared_files WHERE id = ?').get(id) as SharedFile;
  return { ok: true, data: record };
}

// --- Get shared files for an agent ---

export function getSharedFiles(agentId: string): SharedFile[] {
  return getDb().prepare(
    'SELECT * FROM shared_files WHERE to_agent_id = ? ORDER BY created_at DESC'
  ).all(agentId) as SharedFile[];
}

export function getSharedFilesFrom(agentId: string): SharedFile[] {
  return getDb().prepare(
    'SELECT * FROM shared_files WHERE from_agent_id = ? ORDER BY created_at DESC'
  ).all(agentId) as SharedFile[];
}
