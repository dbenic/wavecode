import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { glob } from 'tinyglobby';
import {
  type Result,
  type Guide,
  type GuideSource,
  type Agent,
  insertGuideSource,
  listGuideSources,
  getGuideSource,
  updateGuideSourceSynced,
  deleteGuideSource,
  upsertGuide,
  getGuide,
  getGuideBySlug,
  deleteGuidesNotIn,
  attachGuide as dbAttachGuide,
  detachGuide as dbDetachGuide,
  listGuidesForAgent,
  listGuides,
  getAgent,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { resolvePathWithinRoot } from './path-utils.js';

/** Slug-safe string: <source>/<file-stem> */
function makeSlug(sourceName: string, relPath: string): string {
  const stem = relPath.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9/_-]/g, '-');
  return `${sourceName}/${stem}`;
}

/** Parse YAML frontmatter (between --- delimiters) */
function parseFrontmatter(content: string): { name?: string; description?: string; body: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!fmMatch) return { body: content };

  const fmBlock = fmMatch[1];
  const body = fmMatch[2];
  const result: { name?: string; description?: string; body: string } = { body };

  // Simple YAML key extraction (handles single-line values)
  const nameMatch = fmBlock.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim().replace(/^["']|["']$/g, '');

  const descMatch = fmBlock.match(/^description:\s*(.+)$/m);
  if (descMatch) result.description = descMatch[1].trim().replace(/^["']|["']$/g, '').slice(0, 200);

  return result;
}

/** Title: frontmatter name > first h1 > filename */
function extractTitle(content: string, fallbackFilename: string): string {
  const fm = parseFrontmatter(content);
  if (fm.name) return fm.name.replace(/\b\w/g, (c) => c.toUpperCase());

  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  return fallbackFilename
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Description: frontmatter description > first non-empty paragraph after title, max 200 chars */
function extractDescription(content: string): string | null {
  const fm = parseFrontmatter(content);
  if (fm.description) return fm.description;

  const body = fm.body || content;
  const lines = body.split('\n');
  let inTitle = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) { inTitle = true; continue; }
    if (!inTitle) continue;
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
    return trimmed.slice(0, 200);
  }
  return null;
}

function ensureGuidesRoot(): string {
  const root = getConfig().paths.guides_root;
  const sourcesDir = path.join(root, 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  return root;
}

/** Validate git URL (https only, github/gitlab-like hosts) */
function validateGitUrl(url: string): Result<string> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') {
      return { ok: false, error: 'Only https:// git URLs are allowed' };
    }
    if (u.hostname.includes(' ') || !u.hostname.includes('.')) {
      return { ok: false, error: 'Invalid git URL hostname' };
    }
    return { ok: true, data: url };
  } catch {
    return { ok: false, error: 'Malformed URL' };
  }
}

/** Clean filesystem-safe source name from a name string */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

/**
 * Add a new git source: clone repo, scan for guides, index.
 */
export async function addGitSource(opts: {
  name: string;
  url: string;
  glob?: string;
}): Promise<Result<{ source: GuideSource; indexed: number }>> {
  const urlCheck = validateGitUrl(opts.url);
  if (!urlCheck.ok) return urlCheck;

  const safeName = sanitizeName(opts.name);
  if (!safeName) return { ok: false, error: 'Invalid name' };

  ensureGuidesRoot();
  const root = getConfig().paths.guides_root;
  const relPath = path.join('sources', safeName);
  const cloneTarget = path.join(root, relPath);

  if (fs.existsSync(cloneTarget)) {
    return { ok: false, error: `A source named '${safeName}' already exists` };
  }

  try {
    execFileSync('git', ['clone', '--depth', '1', opts.url, cloneTarget], {
      timeout: 120_000,
      stdio: 'pipe',
    });
  } catch (e) {
    return { ok: false, error: `git clone failed: ${(e as Error).message}` };
  }

  const sourceResult = insertGuideSource({
    name: safeName,
    kind: 'git',
    url: opts.url,
    path: relPath,
    glob: opts.glob ?? '**/*.md',
  });
  if (!sourceResult.ok) {
    // Clean up clone on DB failure
    try { fs.rmSync(cloneTarget, { recursive: true, force: true }); } catch { /* ignore */ }
    return sourceResult;
  }

  const indexed = await indexSource(sourceResult.data.id);
  if (!indexed.ok) {
    return { ok: false, error: indexed.error };
  }

  emit('guide_source.added', 'guide_source', sourceResult.data.id, {
    name: safeName,
    url: opts.url,
    indexed: indexed.data.indexed,
  });

  return { ok: true, data: { source: sourceResult.data, indexed: indexed.data.indexed } };
}

/**
 * Scan a source's files and upsert guides. Removes guides that no longer exist.
 */
export async function indexSource(sourceId: string): Promise<Result<{ indexed: number; removed: number }>> {
  const sourceResult = getGuideSource(sourceId);
  if (!sourceResult.ok) return sourceResult;
  const source = sourceResult.data;

  const root = getConfig().paths.guides_root;
  const sourceDir = path.join(root, source.path);

  if (!fs.existsSync(sourceDir)) {
    return { ok: false, error: `Source directory missing: ${sourceDir}` };
  }

  const files = await glob(source.glob, {
    cwd: sourceDir,
    onlyFiles: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
    absolute: false,
  });

  const slugsKept: string[] = [];
  let indexed = 0;

  for (const relFile of files) {
    const fullPath = path.join(sourceDir, relFile);
    let content: string;
    let stat: fs.Stats;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
      stat = fs.statSync(fullPath);
    } catch { continue; }

    const slug = makeSlug(source.name, relFile);
    const filename = path.basename(relFile);
    const title = extractTitle(content, filename);
    const description = extractDescription(content);

    // file_path is relative to guides_root (not just source dir)
    const fileRelToRoot = path.join(source.path, relFile);

    const result = upsertGuide({
      source_id: source.id,
      slug,
      title,
      file_path: fileRelToRoot,
      description,
      tags: null,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
    if (result.ok) {
      slugsKept.push(slug);
      indexed += 1;
    } else {
      logger.warn({ slug, error: result.error }, 'Failed to upsert guide');
    }
  }

  const removed = deleteGuidesNotIn(sourceId, slugsKept);
  updateGuideSourceSynced(sourceId);
  return { ok: true, data: { indexed, removed } };
}

/** git pull + re-index */
export async function syncSource(sourceId: string): Promise<Result<{ indexed: number; removed: number }>> {
  const sourceResult = getGuideSource(sourceId);
  if (!sourceResult.ok) return sourceResult;
  const source = sourceResult.data;

  if (source.kind === 'git') {
    const root = getConfig().paths.guides_root;
    const sourceDir = path.join(root, source.path);
    try {
      execFileSync('git', ['pull', '--ff-only'], {
        cwd: sourceDir,
        timeout: 60_000,
        stdio: 'pipe',
      });
    } catch (e) {
      return { ok: false, error: `git pull failed: ${(e as Error).message}` };
    }
  }

  const result = await indexSource(sourceId);
  if (result.ok) {
    emit('guide_source.synced', 'guide_source', sourceId, result.data);
  }
  return result;
}

/** Delete source dir + DB rows */
export function removeSource(sourceId: string): Result<void> {
  const sourceResult = getGuideSource(sourceId);
  if (!sourceResult.ok) return sourceResult;
  const source = sourceResult.data;

  const root = getConfig().paths.guides_root;
  const sourceDir = resolvePathWithinRoot(root, source.path);
  if (!sourceDir) {
    return { ok: false, error: 'Refusing to delete path outside guides_root' };
  }

  if (fs.existsSync(sourceDir)) {
    try {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: `Failed to remove source dir: ${(e as Error).message}` };
    }
  }

  deleteGuideSource(sourceId);
  emit('guide_source.removed', 'guide_source', sourceId, { name: source.name });
  return { ok: true, data: undefined };
}

/** Read guide content from disk */
export function readGuideContent(guideId: string): Result<{ guide: Guide; content: string }> {
  const guideResult = getGuide(guideId);
  if (!guideResult.ok) return guideResult;
  const guide = guideResult.data;

  const root = getConfig().paths.guides_root;
  const fullPath = resolvePathWithinRoot(root, guide.file_path);
  if (!fullPath) {
    return { ok: false, error: 'Invalid guide path' };
  }
  if (!fs.existsSync(fullPath)) {
    return { ok: false, error: 'Guide file missing on disk' };
  }
  return { ok: true, data: { guide, content: fs.readFileSync(fullPath, 'utf-8') } };
}

/** Attach a guide to an agent: copy file into workspace + record */
export function attachGuide(agentId: string, guideId: string): Result<void> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return agentResult;
  const agent = agentResult.data;
  if (!agent.workspace) {
    return { ok: false, error: 'Agent has no workspace directory' };
  }

  const readResult = readGuideContent(guideId);
  if (!readResult.ok) return readResult;
  const { guide, content } = readResult.data;

  const guideFilename = guide.slug.replace(/\//g, '__') + '.md';
  const targetDir = path.join(agent.workspace, '.wavecode', 'guides');
  const targetPath = path.join(targetDir, guideFilename);

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, `<!-- Guide: ${guide.title} (slug: ${guide.slug}) -->\n` + content, 'utf-8');

    // Append .wavecode/ to .gitignore if git repo
    const gitignorePath = path.join(agent.workspace, '.gitignore');
    const gitDir = path.join(agent.workspace, '.git');
    if (fs.existsSync(gitDir)) {
      let gitignore = '';
      if (fs.existsSync(gitignorePath)) {
        gitignore = fs.readFileSync(gitignorePath, 'utf-8');
      }
      if (!gitignore.split('\n').some((l) => l.trim() === '.wavecode/' || l.trim() === '.wavecode')) {
        const prefix = gitignore && !gitignore.endsWith('\n') ? '\n' : '';
        fs.writeFileSync(gitignorePath, gitignore + prefix + '.wavecode/\n', 'utf-8');
      }
    }
  } catch (e) {
    return { ok: false, error: `Failed to write guide: ${(e as Error).message}` };
  }

  const dbResult = dbAttachGuide(agentId, guideId);
  if (!dbResult.ok) return dbResult;

  emit('agent.guide_attached', 'agent', agentId, {
    guide_id: guideId,
    guide_slug: guide.slug,
    guide_title: guide.title,
    file_path: path.relative(agent.workspace, targetPath),
  });
  return { ok: true, data: undefined };
}

/** Detach a guide: remove workspace file + DB row */
export function detachGuide(agentId: string, guideId: string): Result<void> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return agentResult;
  const agent = agentResult.data;

  const guideResult = getGuide(guideId);
  if (!guideResult.ok) return guideResult;
  const guide = guideResult.data;

  if (agent.workspace) {
    const guideFilename = guide.slug.replace(/\//g, '__') + '.md';
    const targetPath = resolvePathWithinRoot(agent.workspace, path.join('.wavecode', 'guides', guideFilename));
    if (targetPath && fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch { /* best effort */ }
    }
  }

  dbDetachGuide(agentId, guideId);
  emit('agent.guide_detached', 'agent', agentId, {
    guide_id: guideId,
    guide_slug: guide.slug,
  });
  return { ok: true, data: undefined };
}

/** Attach guides by slug list (used by template spawn) */
export function attachGuidesBySlug(agentId: string, slugs: string[]): { attached: number; errors: string[] } {
  let attached = 0;
  const errors: string[] = [];
  for (const slug of slugs) {
    const guideResult = getGuideBySlug(slug);
    if (!guideResult.ok) {
      errors.push(`${slug}: not found`);
      continue;
    }
    const result = attachGuide(agentId, guideResult.data.id);
    if (result.ok) attached += 1;
    else errors.push(`${slug}: ${result.error}`);
  }
  return { attached, errors };
}

// Re-exports for routes
export { listGuideSources, listGuides, listGuidesForAgent };
export type { Agent };
