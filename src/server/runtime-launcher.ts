import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getConfig, type RuntimeConfig } from './config.js';
import { isEffortLevel, type Result } from './db.js';
import * as tmux from './tmux.js';

/**
 * Model names end up embedded in a shell command sent to tmux, so the
 * allowed alphabet is deliberately narrow. Mirrors validate.isValidModelName.
 */
const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,99}$/;

export interface RuntimePin {
  model?: string | null;
  effort?: EffortPin;
}
type EffortPin = string | null | undefined;

/**
 * Build the launch command for a runtime, injecting the agent's pinned
 * model/effort via the runtime's configured flags. A pin whose value fails
 * the safety pattern is skipped (never silently shell-embedded), and a
 * runtime without the corresponding flag leaves the command unchanged —
 * the pin is still recorded on the agent and validated at review time.
 */
export function buildRuntimeCommand(runtimeConfig: RuntimeConfig, pin: RuntimePin = {}): string {
  let command = runtimeConfig.command;

  if (pin.model && runtimeConfig.model_flag && SAFE_MODEL_PATTERN.test(pin.model)) {
    command += ` ${runtimeConfig.model_flag} ${pin.model}`;
  }
  if (pin.effort && runtimeConfig.effort_flag && isEffortLevel(pin.effort)) {
    command += ` ${runtimeConfig.effort_flag} ${pin.effort}`;
  }

  return command;
}

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
  model?: string | null;
  effort?: string | null;
}): Result<void> {
  const runtimeConfig = getConfig().runtimes[opts.runtime];
  if (!runtimeConfig) {
    return { ok: false, error: `Unknown runtime '${opts.runtime}'` };
  }

  try {
    // newSession creates a shell first, then sends the command as keystrokes
    // so the session survives even if the command fails
    tmux.newSession(opts.sessionName, opts.workDir, buildRuntimeCommand(runtimeConfig, opts));

    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: `Failed to create tmux session: ${(e as Error).message}` };
  }
}
