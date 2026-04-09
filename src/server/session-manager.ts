import {
  getDb,
  insertAgent,
  getAgent,
  getAgentByName,
  listAgents,
  deleteAgent,
  updateAgentStatus,
  type Agent,
  type Result,
} from './db.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { startRunner, stopRunner } from './runner.js';
import { createWorktree, launchRuntimeInNewSession } from './runtime-launcher.js';
import * as tmux from './tmux.js';

export interface TmuxSession {
  name: string;
  created: number;
  lastActivity: number;
}

export function scan(): Result<TmuxSession[]> {
  return tmux.listSessions();
}

export function adopt(
  sessionName: string,
  runtime: Agent['runtime'],
  name?: string,
): Result<Agent> {
  // Verify session exists
  if (!tmux.hasSession(sessionName)) {
    return { ok: false, error: `tmux session '${sessionName}' not found` };
  }

  // Check not already adopted
  const existing = listAgents().find((a) => a.tmux_session === sessionName);
  if (existing) {
    return { ok: false, error: `Session '${sessionName}' already adopted as agent '${existing.name}'` };
  }

  return insertAgent({
    name: name ?? sessionName,
    runtime,
    tmux_session: sessionName,
    workspace: null,
    mode: 'adopted',
    status: 'idle',
  });
}

export interface SpawnOptions {
  name: string;
  runtime: Agent['runtime'];
  repo?: string;
  branch?: string;
  /** Explicit workspace path (bypasses worktree creation and projects_root resolution) */
  workspace?: string;
}

export function spawnAgent(opts: SpawnOptions): Result<Agent> {
  const config = getConfig();
  const runtimeConfig = config.runtimes[opts.runtime];
  if (!runtimeConfig) {
    return { ok: false, error: `Unknown runtime '${opts.runtime}'` };
  }

  const sessionName = `wc-${opts.name}`;

  // Check session name not taken
  if (tmux.hasSession(sessionName)) {
    return { ok: false, error: `tmux session '${sessionName}' already exists` };
  }

  // Check agent name not taken
  const existing = listAgents().find((a) => a.name === opts.name);
  if (existing) {
    return { ok: false, error: `Agent name '${opts.name}' already in use` };
  }

  // Create git worktree if repo provided
  let workspace: string | null = null;
  if (opts.workspace) {
    // Explicit workspace override (e.g., from template spawn)
    workspace = opts.workspace;
  } else if (opts.repo) {
    const worktree = createWorktree(opts.name, opts.repo, opts.branch ?? `wc-${opts.name}`);
    if (!worktree.ok) return worktree;
    workspace = worktree.data;
  }

  // Resolve workspace:
  // 1. Explicit workspace, 2. Repo worktree, 3. projects_root/<agent-name>
  if (!workspace && config.paths.projects_root) {
    const projectDir = path.join(config.paths.projects_root, opts.name);
    // Auto-create project directory + git init if it doesn't exist
    if (!fs.existsSync(projectDir)) {
      fs.mkdirSync(projectDir, { recursive: true });
      try {
        execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, timeout: 5000 });
      } catch { /* git init is best-effort */ }
    }
    workspace = projectDir;
  }

  if (!workspace) {
    return {
      ok: false,
      error: 'Spawned agents require a workspace. Configure paths.projects_root or provide a repo/workspace.',
    };
  }

  const launchResult = launchRuntimeInNewSession({
    sessionName,
    workDir: workspace,
    runtime: opts.runtime,
  });
  if (!launchResult.ok) return launchResult;

  // Create agent record
  const agentResult = insertAgent({
    name: opts.name,
    runtime: opts.runtime,
    tmux_session: sessionName,
    workspace,
    mode: 'spawned',
    status: 'idle',
  });

  if (!agentResult.ok) {
    // Clean up tmux session on failure
    tmux.killSession(sessionName);
    return agentResult;
  }

  const agent = agentResult.data;

  // Start the runner for this agent
  startRunner(agent.id, sessionName, opts.runtime);

  return { ok: true, data: agent };
}

/**
 * Upgrade an adopted agent to spawned mode.
 * Detaches from existing session, creates a new session with runner wrapper.
 */
export function upgrade(agentId: string, repo?: string): Result<Agent> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return agentResult;

  const agent = agentResult.data;
  if (agent.mode !== 'adopted') {
    return { ok: false, error: `Agent '${agent.name}' is already in ${agent.mode} mode` };
  }

  const config = getConfig();
  const runtimeConfig = config.runtimes[agent.runtime];
  if (!runtimeConfig) return { ok: false, error: `Unknown runtime '${agent.runtime}'` };

  const newSessionName = `wc-${agent.name}`;

  // Create workspace
  let workspace: string | null = null;
  if (repo) {
    const worktree = createWorktree(agent.name, repo, `wc-${agent.name}`);
    if (!worktree.ok) return worktree;
    workspace = worktree.data;
  }

  // Create new tmux session
  const workDir = workspace ?? repo ?? process.cwd();
  const launchResult = launchRuntimeInNewSession({
    sessionName: newSessionName,
    workDir,
    runtime: agent.runtime,
  });
  if (!launchResult.ok) return launchResult;

  // Update agent record
  try {
    getDb().prepare(`
      UPDATE agents SET mode = 'spawned', tmux_session = ?, workspace = ? WHERE id = ?
    `).run(newSessionName, workspace, agentId);
  } catch (e) {
    tmux.killSession(newSessionName);
    return { ok: false, error: `Failed to persist upgraded agent: ${(e as Error).message}` };
  }

  // Start runner
  startRunner(agentId, newSessionName, agent.runtime);

  return getAgent(agentId);
}

export function ensureSpawnedAgentSession(agentId: string): Result<{ agent: Agent; createdSession: boolean }> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return agentResult as Result<{ agent: Agent; createdSession: boolean }>;

  const agent = agentResult.data;
  if (agent.mode !== 'spawned') {
    return { ok: false, error: `Agent '${agent.name}' is not in spawned mode` };
  }

  let createdSession = false;
  if (!tmux.hasSession(agent.tmux_session)) {
    const workDir = agent.workspace ?? process.cwd();
    const launchResult = launchRuntimeInNewSession({
      sessionName: agent.tmux_session,
      workDir,
      runtime: agent.runtime,
    });
    if (!launchResult.ok) {
      return { ok: false, error: launchResult.error };
    }

    createdSession = true;
    updateAgentStatus(agent.id, 'idle');
  }

  startRunner(agent.id, agent.tmux_session, agent.runtime);

  const refreshed = getAgent(agent.id);
  if (!refreshed.ok) {
    return { ok: false, error: refreshed.error };
  }

  return {
    ok: true,
    data: {
      agent: refreshed.data,
      createdSession,
    },
  };
}

export function list(): Agent[] {
  return listAgents();
}

export function get(idOrName: string): Result<Agent> {
  const byId = getAgent(idOrName);
  if (byId.ok) return byId;
  return getAgentByName(idOrName);
}

export function kill(agentId: string): Result<void> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const agent = agentResult.data;
  if (agent.mode === 'adopted') {
    return { ok: false, error: 'Cannot kill adopted session. Detach it instead.' };
  }

  // Stop runner if active
  stopRunner(agentId);

  // Session might already be dead — killSession is safe
  tmux.killSession(agent.tmux_session);

  return deleteAgent(agentId);
}

export function sendKeys(agentId: string, text: string): Result<void> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const agent = agentResult.data;
  if (!tmux.hasSession(agent.tmux_session)) {
    return { ok: false, error: `tmux session '${agent.tmux_session}' is not running` };
  }

  try {
    tmux.sendTextAndEnter(agent.tmux_session, text);
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Send raw tmux key names (C-c, Escape, Enter, etc.) without -l flag.
 * Does NOT append Enter automatically.
 * Only allows keys from an explicit allowlist to prevent injection.
 */
export function sendRawKeys(agentId: string, key: string): Result<void> {
  if (!tmux.isAllowedRawKey(key)) {
    return { ok: false, error: `Disallowed key: ${key}` };
  }

  const agentResult = getAgent(agentId);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const agent = agentResult.data;
  if (!tmux.hasSession(agent.tmux_session)) {
    return { ok: false, error: `tmux session '${agent.tmux_session}' is not running` };
  }

  try {
    tmux.sendRawKey(agent.tmux_session, key);
    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function capturePane(session: string, lines: number = 50): Result<string> {
  return tmux.capturePane(session, lines);
}

export function capturePaneAnsi(session: string, lines: number = 50): Result<string> {
  return tmux.capturePaneAnsi(session, lines);
}

export function capturePaneRange(session: string, start: number, end: number): Result<string> {
  return tmux.capturePaneRange(session, start, end);
}

export function getScrollbackSize(session: string): Result<number> {
  return tmux.getScrollbackSize(session);
}
