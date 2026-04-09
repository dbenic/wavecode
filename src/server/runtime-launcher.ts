import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getConfig } from './config.js';
import type { Result } from './db.js';
import * as tmux from './tmux.js';

export function getWorktreesRoot(): string {
  return getConfig().paths.worktrees_root;
}

export function getTranscriptsRoot(): string {
  return getConfig().paths.transcripts_root;
}

export function getTeamsRoot(): string {
  return getConfig().paths.teams_root;
}

export function createWorktree(agentName: string, repo: string, branch?: string): Result<string> {
  const worktreeBase = getWorktreesRoot();
  const workspace = path.join(worktreeBase, agentName);

  try {
    execFileSync('mkdir', ['-p', worktreeBase], { timeout: 5000 });
    execFileSync('git', ['-C', repo, 'worktree', 'add', workspace, '-b', branch ?? `wc-${agentName}`], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { ok: true, data: workspace };
  } catch (e) {
    return { ok: false, error: `Failed to create worktree: ${(e as Error).message}` };
  }
}

export function launchRuntimeInNewSession(opts: {
  sessionName: string;
  workDir: string;
  runtime: string;
}): Result<void> {
  const runtimeConfig = getConfig().runtimes[opts.runtime];
  if (!runtimeConfig) {
    return { ok: false, error: `Unknown runtime '${opts.runtime}'` };
  }

  try {
    // newSession creates a shell first, then sends the command as keystrokes
    // so the session survives even if the command fails
    tmux.newSession(opts.sessionName, opts.workDir, runtimeConfig.command);

    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: `Failed to create tmux session: ${(e as Error).message}` };
  }
}
