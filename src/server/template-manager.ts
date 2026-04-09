import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import yaml from 'js-yaml';
import {
  type Result,
  type Template,
  type Agent,
  insertTemplate,
  listTemplates,
  getTemplate,
  getTemplateBySlug,
  deleteTemplate,
  updateTemplateFromManifest,
  setTemplateTrusted,
  insertTemplateSpawn,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import * as outputWatcher from './output-watcher.js';
import { attachGuidesBySlug } from './guide-manager.js';
import logger from './logger.js';
import { resolvePathWithinRoot } from './path-utils.js';

interface TemplateManifest {
  name: string;
  description?: string;
  default_runtime?: string;
  required_env?: string[];
  post_clone?: string[];
  attach_guides?: string[];
}

function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().slice(0, 64);
}

function validateGitUrl(url: string): Result<string> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// git URLs allowed' };
    if (!u.hostname.includes('.')) return { ok: false, error: 'Invalid hostname' };
    return { ok: true, data: url };
  } catch {
    return { ok: false, error: 'Malformed URL' };
  }
}

function ensureTemplatesRoot(): string {
  const root = getConfig().paths.templates_root;
  const sourcesDir = path.join(root, 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  return root;
}

/** Parse wavecode.yaml from cloned repo. Returns null if missing (caller decides fallback). */
function parseManifest(cloneDir: string): TemplateManifest | null {
  const manifestPath = path.join(cloneDir, 'wavecode.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = yaml.load(raw) as TemplateManifest | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.name) return null;
    return parsed;
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'Failed to parse wavecode.yaml');
    return null;
  }
}

/** Generate minimal manifest from README/package.json if wavecode.yaml missing */
function inferManifest(cloneDir: string, slug: string): TemplateManifest {
  let description: string | undefined;
  const readmePath = path.join(cloneDir, 'README.md');
  if (fs.existsSync(readmePath)) {
    try {
      const content = fs.readFileSync(readmePath, 'utf-8');
      // First non-empty paragraph after title
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```') && !trimmed.startsWith('<')) {
          description = trimmed.slice(0, 200);
          break;
        }
      }
    } catch { /* ignore */ }
  }
  return {
    name: slug,
    description,
    default_runtime: 'claude-code',
    required_env: [],
    post_clone: [],
    attach_guides: [],
  };
}

/**
 * Add a template by cloning git repo and parsing its manifest.
 */
export async function addTemplate(opts: { git_url: string }): Promise<Result<Template>> {
  const urlCheck = validateGitUrl(opts.git_url);
  if (!urlCheck.ok) return urlCheck;

  // Derive slug from URL
  const pathname = new URL(opts.git_url).pathname;
  const repoName = pathname.split('/').pop()?.replace(/\.git$/, '') ?? 'template';
  const slug = sanitizeSlug(repoName);
  if (!slug) return { ok: false, error: 'Could not derive template slug from URL' };

  // Check slug not already used
  const existing = getTemplateBySlug(slug);
  if (existing.ok) {
    return { ok: false, error: `Template '${slug}' already exists` };
  }

  ensureTemplatesRoot();
  const root = getConfig().paths.templates_root;
  const relPath = path.join('sources', slug);
  const cloneTarget = path.join(root, relPath);

  if (fs.existsSync(cloneTarget)) {
    return { ok: false, error: `Clone target already exists: ${cloneTarget}` };
  }

  try {
    execFileSync('git', ['clone', '--depth', '1', opts.git_url, cloneTarget], {
      timeout: 120_000,
      stdio: 'pipe',
    });
  } catch (e) {
    return { ok: false, error: `git clone failed: ${(e as Error).message}` };
  }

  const manifest = parseManifest(cloneTarget) ?? inferManifest(cloneTarget, slug);

  const result = insertTemplate({
    slug,
    name: manifest.name,
    description: manifest.description ?? null,
    git_url: opts.git_url,
    local_path: relPath,
    default_runtime: manifest.default_runtime ?? null,
    required_env: manifest.required_env ? JSON.stringify(manifest.required_env) : null,
    post_clone_cmd: manifest.post_clone ? manifest.post_clone.join(' && ') : null,
    attach_guide_slugs: manifest.attach_guides ? JSON.stringify(manifest.attach_guides) : null,
    manifest_json: JSON.stringify(manifest),
    trusted: 0,
  });
  if (!result.ok) {
    try { fs.rmSync(cloneTarget, { recursive: true, force: true }); } catch { /* ignore */ }
    return result;
  }

  emit('template.added', 'template', result.data.id, { slug, git_url: opts.git_url });
  return result;
}

/** git pull + re-read manifest */
export async function syncTemplate(id: string): Promise<Result<Template>> {
  const result = getTemplate(id);
  if (!result.ok) return result;
  const template = result.data;

  if (!template.git_url) {
    return { ok: false, error: 'Cannot sync a non-git template' };
  }

  const root = getConfig().paths.templates_root;
  const cloneDir = path.join(root, template.local_path);
  try {
    execFileSync('git', ['pull', '--ff-only'], { cwd: cloneDir, timeout: 60_000, stdio: 'pipe' });
  } catch (e) {
    return { ok: false, error: `git pull failed: ${(e as Error).message}` };
  }

  const manifest = parseManifest(cloneDir) ?? inferManifest(cloneDir, template.slug);
  const updated = updateTemplateFromManifest(id, {
    name: manifest.name,
    description: manifest.description ?? null,
    default_runtime: manifest.default_runtime ?? null,
    required_env: manifest.required_env ? JSON.stringify(manifest.required_env) : null,
    post_clone_cmd: manifest.post_clone ? manifest.post_clone.join(' && ') : null,
    attach_guide_slugs: manifest.attach_guides ? JSON.stringify(manifest.attach_guides) : null,
    manifest_json: JSON.stringify(manifest),
  });

  if (updated.ok) {
    emit('template.synced', 'template', id, { slug: template.slug });
  }
  return updated;
}

/** Delete template clone dir + DB row */
export function removeTemplate(id: string): Result<void> {
  const result = getTemplate(id);
  if (!result.ok) return result;
  const template = result.data;

  const root = getConfig().paths.templates_root;
  const cloneDir = resolvePathWithinRoot(root, template.local_path);
  if (!cloneDir) {
    return { ok: false, error: 'Refusing to delete path outside templates_root' };
  }

  if (fs.existsSync(cloneDir)) {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); }
    catch (e) { return { ok: false, error: `Failed to remove clone: ${(e as Error).message}` }; }
  }

  deleteTemplate(id);
  emit('template.removed', 'template', id, { slug: template.slug });
  return { ok: true, data: undefined };
}

/** Mark template as trusted (user approved post_clone_cmd) */
export function trustTemplate(id: string): Result<Template> {
  return setTemplateTrusted(id, true);
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue; // strip template's git history
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

export interface SpawnFromTemplateOpts {
  templateId: string;
  agentName: string;
  runtime?: string;
  env?: Record<string, string>;
}

export interface SpawnFromTemplateResult {
  agent: Agent;
  steps: string[];
  guidesAttached: number;
  guideErrors: string[];
  postCloneOutput: string;
  postCloneSkipped: boolean;
}

/**
 * Full template spawn pipeline:
 *   1. Validate template + env
 *   2. Copy template files into <projects_root>/<agentName>/
 *   3. git init (fresh history)
 *   4. Write .env from inputs
 *   5. Run post_clone_cmd (if trusted)
 *   6. Call spawnAgent with explicit workspace
 *   7. Auto-attach declared guides
 */
export async function spawnFromTemplate(
  opts: SpawnFromTemplateOpts,
): Promise<Result<SpawnFromTemplateResult>> {
  const config = getConfig();
  const steps: string[] = [];

  const templateResult = getTemplate(opts.templateId);
  if (!templateResult.ok) return templateResult;
  const template = templateResult.data;

  const runtime = opts.runtime ?? template.default_runtime;
  if (!runtime) return { ok: false, error: 'No runtime specified and template has no default' };

  // Validate required env keys
  const requiredEnv: string[] = template.required_env ? JSON.parse(template.required_env) : [];
  const providedEnv = opts.env ?? {};
  const missing = requiredEnv.filter((k) => !providedEnv[k] || providedEnv[k].trim() === '');
  if (missing.length > 0) {
    return { ok: false, error: `Missing required env: ${missing.join(', ')}` };
  }

  // Resolve target workspace dir
  if (!config.paths.projects_root) {
    return { ok: false, error: 'paths.projects_root is not configured' };
  }
  const workspace = resolvePathWithinRoot(config.paths.projects_root, opts.agentName);
  if (!workspace) {
    return { ok: false, error: 'Invalid agent name for workspace path' };
  }
  if (fs.existsSync(workspace)) {
    return { ok: false, error: `Workspace already exists: ${workspace}` };
  }

  const templateSrc = path.join(config.paths.templates_root, template.local_path);
  if (!fs.existsSync(templateSrc)) {
    return { ok: false, error: `Template source missing on disk: ${templateSrc}` };
  }

  // 1. Copy template (without .git)
  try {
    copyDir(templateSrc, workspace);
    steps.push(`Copied template to ${workspace}`);
  } catch (e) {
    return { ok: false, error: `Failed to copy template: ${(e as Error).message}` };
  }

  // 2. Fresh git init
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, timeout: 5000, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: workspace, timeout: 15000, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `init from template ${template.slug}`], {
      cwd: workspace, timeout: 15000, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'WaveCode', GIT_AUTHOR_EMAIL: 'wavecode@local', GIT_COMMITTER_NAME: 'WaveCode', GIT_COMMITTER_EMAIL: 'wavecode@local' },
    });
    steps.push('git init + initial commit');
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'git init/commit failed in template spawn');
    steps.push('git init skipped');
  }

  // 3. Write .env
  if (Object.keys(providedEnv).length > 0) {
    const envContent = Object.entries(providedEnv)
      .map(([k, v]) => `${k}=${v.replace(/\n/g, ' ')}`)
      .join('\n') + '\n';
    try {
      fs.writeFileSync(path.join(workspace, '.env'), envContent, { mode: 0o600 });
      steps.push('.env written');
    } catch (e) {
      logger.warn({ error: (e as Error).message }, 'Failed to write .env');
    }
  }

  // 4. Run post_clone_cmd IF trusted
  let postCloneOutput = '';
  let postCloneSkipped = false;
  if (template.post_clone_cmd && template.trusted) {
    try {
      const output = await runShellCmd(template.post_clone_cmd, workspace, 300_000);
      postCloneOutput = output;
      steps.push('post_clone completed');
    } catch (e) {
      // Clean up workspace on post_clone failure
      try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
      return { ok: false, error: `post_clone failed: ${(e as Error).message}` };
    }
  } else if (template.post_clone_cmd && !template.trusted) {
    postCloneSkipped = true;
    steps.push('post_clone SKIPPED (template not trusted)');
  }

  // 5. Spawn agent with explicit workspace
  const spawnResult = sessionManager.spawnAgent({
    name: opts.agentName,
    runtime,
    workspace,
  });
  if (!spawnResult.ok) {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: `Spawn failed: ${spawnResult.error}` };
  }
  const agent = spawnResult.data;
  steps.push(`Spawned agent ${agent.name}`);

  // Start output watcher
  outputWatcher.startWatching(agent.id);
  emit('agent.spawned', 'agent', agent.id, { name: agent.name, runtime: agent.runtime, from_template: template.slug });

  // 6. Auto-attach guides declared in manifest
  let guidesAttached = 0;
  let guideErrors: string[] = [];
  const guideSlugs: string[] = template.attach_guide_slugs ? JSON.parse(template.attach_guide_slugs) : [];
  if (guideSlugs.length > 0) {
    const result = attachGuidesBySlug(agent.id, guideSlugs);
    guidesAttached = result.attached;
    guideErrors = result.errors;
    if (guidesAttached > 0) {
      steps.push(`Attached ${guidesAttached} guide(s)`);
    }
  }

  // 7. Audit trail
  insertTemplateSpawn(template.id, agent.id, Object.keys(providedEnv));
  emit('template.spawned', 'template', template.id, {
    agent_id: agent.id,
    agent_name: agent.name,
    template_slug: template.slug,
  });

  return {
    ok: true,
    data: {
      agent,
      steps,
      guidesAttached,
      guideErrors,
      postCloneOutput,
      postCloneSkipped,
    },
  };
}

/** Run a shell command, returning its stdout+stderr. Rejects on non-zero exit. */
function runShellCmd(cmd: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.stderr.on('data', (d) => { output += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`exit ${code}: ${output.slice(-500)}`));
    });
  });
}

export { listTemplates };
