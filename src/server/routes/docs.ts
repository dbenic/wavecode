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
  modified: string;
  agentId?: string;
  agentName?: string;
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
    entries.push({
      slug: 'claude-md',
      title: 'Project Architecture (CLAUDE.md)',
      path: 'CLAUDE.md',
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }

  // docs/ folder
  const docsDir = getDocsDir();
  if (fs.existsSync(docsDir)) {
    const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort();
    for (const file of files) {
      const filePath = path.join(docsDir, file);
      const stat = fs.statSync(filePath);
      entries.push({
        slug: createRootDocSlug(file),
        title: titleFromFilename(file),
        path: `docs/${file}`,
        size: stat.size,
        modified: stat.mtime.toISOString(),
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
        entries.push({
          slug: createAgentDocSlug(agent.id, relPath),
          title: titleFromFilename(relPath.split('/').pop() ?? relPath),
          path: relPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
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
}
