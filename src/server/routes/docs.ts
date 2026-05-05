import type { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import type { NodeAppEnv } from '../auth.js';
import { getAgent, listAgents } from '../db.js';
import { createAgentDocSlug, createLegacyAgentDocSlug, createRootDocSlug } from '../doc-slugs.js';
import { resolvePathWithinRoot } from '../path-utils.js';

interface DocEntry {
  slug: string;
  title: string;
  path: string;
  size: number;
  modified: string;       // alias of updatedAt, kept for backward compat with older clients
  createdAt: string;
  updatedAt: string;
  agentId?: string;
  agentName?: string;
}

/**
 * Best-effort "creation time" for a file. Some filesystems (ext4 without
 * inode_birthtime, or files created before the FS supported it) report
 * birthtime as the Unix epoch; in that case fall back to mtime so the
 * UI never shows a 1970 date.
 */
function getCreatedAt(stat: fs.Stats): string {
  const birth = stat.birthtimeMs;
  if (!birth || birth <= 0) return stat.mtime.toISOString();
  return stat.birthtime.toISOString();
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getDocsDir(): string {
  return path.join(process.cwd(), 'docs');
}

/** Scan a directory recursively for .md files (max depth 3) */
function scanMdFiles(dir: string, prefix: string, depth = 0): { relPath: string; fullPath: string }[] {
  if (depth > 3 || !fs.existsSync(dir)) return [];
  const results: { relPath: string; fullPath: string }[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push({ relPath, fullPath });
      } else if (entry.isDirectory() && depth < 3) {
        results.push(...scanMdFiles(fullPath, relPath, depth + 1));
      }
    }
  } catch { /* permission errors etc */ }
  return results;
}

function listDocs(): DocEntry[] {
  const entries: DocEntry[] = [];

  // CLAUDE.md at root
  const claudeMd = path.join(process.cwd(), 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    const stat = fs.statSync(claudeMd);
    const updated = stat.mtime.toISOString();
    entries.push({
      slug: 'claude-md',
      title: 'Project Architecture (CLAUDE.md)',
      path: 'CLAUDE.md',
      size: stat.size,
      modified: updated,
      createdAt: getCreatedAt(stat),
      updatedAt: updated,
    });
  }

  // docs/ folder
  const docsDir = getDocsDir();
  if (fs.existsSync(docsDir)) {
    const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();
    for (const file of files) {
      const filePath = path.join(docsDir, file);
      const stat = fs.statSync(filePath);
      const updated = stat.mtime.toISOString();
      entries.push({
        slug: createRootDocSlug(file),
        title: titleFromFilename(file),
        path: `docs/${file}`,
        size: stat.size,
        modified: updated,
        createdAt: getCreatedAt(stat),
        updatedAt: updated,
      });
    }
  }

  // Agent workspace .md files
  const agents = listAgents();
  for (const agent of agents) {
    if (!agent.workspace) continue;
    const mdFiles = scanMdFiles(agent.workspace, '', 0);
    for (const { relPath, fullPath } of mdFiles) {
      try {
        const stat = fs.statSync(fullPath);
        const updated = stat.mtime.toISOString();
        entries.push({
          slug: createAgentDocSlug(agent.id, relPath),
          title: titleFromFilename(relPath.split('/').pop() ?? relPath),
          path: relPath,
          size: stat.size,
          modified: updated,
          createdAt: getCreatedAt(stat),
          updatedAt: updated,
          agentId: agent.id,
          agentName: agent.name,
        });
      } catch { /* stat failed */ }
    }
  }

  return entries;
}

function readDoc(slug: string): { title: string; content: string; path: string; agentId?: string; agentName?: string } | null {
  const docs = listDocs();
  let doc = docs.find((d) => d.slug === slug);

  // Fallback for previously-generated agent doc slugs based on basename only.
  if (!doc) {
    doc = docs.find((d) => d.agentId && createLegacyAgentDocSlug(d.agentId, d.path) === slug);
  }
  if (!doc) return null;

  // Agent workspace doc — resolve from agent's workspace dir
  if (doc.agentId) {
    const result = getAgent(doc.agentId);
    if (!result.ok || !result.data.workspace) return null;
    const workspace = result.data.workspace;
    const fullPath = resolvePathWithinRoot(workspace, doc.path);
    if (!fullPath) return null;
    if (!fs.existsSync(fullPath)) return null;
    return {
      title: doc.title,
      content: fs.readFileSync(fullPath, 'utf-8'),
      path: doc.path,
      agentId: doc.agentId,
      agentName: doc.agentName,
    };
  }

  // WaveCode's own doc
  const fullPath = resolvePathWithinRoot(process.cwd(), doc.path);
  if (!fullPath) return null;
  if (!fs.existsSync(fullPath)) return null;

  return {
    title: doc.title,
    content: fs.readFileSync(fullPath, 'utf-8'),
    path: doc.path,
  };
}

/** Read a specific file from an agent's workspace by path */
function readAgentFile(agentId: string, filePath: string): { title: string; content: string; path: string; agentId: string; agentName: string } | null {
  const result = getAgent(agentId);
  if (!result.ok || !result.data.workspace) return null;
  const agent = result.data;
  const workspace = agent.workspace;
  if (!workspace) return null;

  const fullPath = resolvePathWithinRoot(workspace, filePath);
  if (!fullPath) return null;
  if (!fs.existsSync(fullPath)) return null;

  const relativePath = path.relative(workspace, fullPath).split(path.sep).join('/');

  return {
    title: titleFromFilename(relativePath.split('/').pop() ?? relativePath),
    content: fs.readFileSync(fullPath, 'utf-8'),
    path: relativePath,
    agentId: agent.id,
    agentName: agent.name,
  };
}

export function registerDocsRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/docs', (c) => {
    return c.json(listDocs());
  });

  app.get('/api/docs/:slug', (c) => {
    const doc = readDoc(c.req.param('slug'));
    if (!doc) return c.json({ error: 'Document not found' }, 404);
    return c.json(doc);
  });

  // Read a file from an agent's workspace
  app.get('/api/agents/:id/file/:path{.+}', (c) => {
    const agentId = c.req.param('id');
    const filePath = c.req.param('path');
    const doc = readAgentFile(agentId, filePath);
    if (!doc) return c.json({ error: 'File not found' }, 404);
    return c.json(doc);
  });

  /**
   * Write a markdown doc into an agent's workspace. Used by external
   * tools (e.g. the QA agent) to attach reports to a specific agent so
   * they appear under that agent's docs in the UI.
   */
  app.post('/api/agents/:id/docs', async (c) => {
    const agentId = c.req.param('id');
    const result = getAgent(agentId);
    if (!result.ok) return c.json({ error: 'Agent not found' }, 404);
    const workspace = result.data.workspace;
    if (!workspace) {
      return c.json({ error: 'Agent has no workspace; cannot write doc' }, 400);
    }

    const body = await c.req.json<{ filename: string; content: string; subdir?: string }>();
    if (!body || typeof body.filename !== 'string' || typeof body.content !== 'string') {
      return c.json({ error: 'filename (string) and content (string) required' }, 400);
    }

    const safeFilename = path.basename(body.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!safeFilename.endsWith('.md')) {
      return c.json({ error: 'Filename must end in .md' }, 400);
    }

    const subdir = body.subdir ?? '';
    if (subdir.includes('..') || path.isAbsolute(subdir)) {
      return c.json({ error: 'subdir must be a simple relative path' }, 400);
    }

    const targetDir = path.resolve(workspace, subdir);
    if (!targetDir.startsWith(path.resolve(workspace))) {
      return c.json({ error: 'Path traversal detected' }, 400);
    }

    fs.mkdirSync(targetDir, { recursive: true });
    const fullPath = path.join(targetDir, safeFilename);
    fs.writeFileSync(fullPath, body.content, 'utf-8');

    const relPath = path.relative(workspace, fullPath).split(path.sep).join('/');
    const slug = createAgentDocSlug(agentId, relPath);
    return c.json(
      { ok: true, path: relPath, slug, url: `/docs/${slug}` },
      201,
    );
  });
}
