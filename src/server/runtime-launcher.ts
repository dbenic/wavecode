import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workspaceMatches } from './project-gate.js';
import { emit } from './event-bus.js';
import { getConfig, type RuntimeConfig } from './config.js';
import { isEffortLevel, type Result } from './db.js';
import * as tmux from './tmux.js';
import { isSafeEnvKey, isSafeEnvValue } from './profile-validation.js';
import { resolveProfileEnv } from './profiles.js';

/**
 * Model names end up embedded in a shell command sent to tmux, so the
 * allowed alphabet is deliberately narrow. Mirrors validate.isValidModelName.
 */
const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,99}$/;

export interface RuntimePin {
  model?: string | null;
  effort?: EffortPin;
  /**
   * Launch env (credential profile, spec §5), rendered as an `env K=V …`
   * prefix. Pass the output of resolveProfileEnv(); a pair that fails the
   * strict key/value alphabet is never shell-embedded.
   */
  env?: Record<string, string>;
  /** Relaunch of a runtime that ran before here: append `resume_args` so it continues its conversation. */
  resume?: boolean;
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
    // Flags that already end with `=` (e.g. `-c model_reasoning_effort=`) take
    // the value with no extra space so Codex sees `key=xhigh`, not `key= xhigh`.
    command += runtimeConfig.effort_flag.endsWith('=')
      ? ` ${runtimeConfig.effort_flag}${pin.effort}`
      : ` ${runtimeConfig.effort_flag} ${pin.effort}`;
  }

  if (pin.resume && runtimeConfig.resume_args && /^[\w .=-]{1,64}$/.test(runtimeConfig.resume_args)) {
    command += ` ${runtimeConfig.resume_args.trim()}`;
  }

  const envPairs = Object.entries(pin.env ?? {}).filter(([k, v]) => isSafeEnvKey(k) && isSafeEnvValue(v));
  if (envPairs.length > 0) {
    // `env` scopes the vars to this process only and keeps PATH (grok's HOME override relies on it)
    command = `env ${envPairs.map(([k, v]) => `${k}=${v}`).join(' ')} ${command}`;
  }

  return command;
}

/**
 * Full launch command for an agent: runtime command + model/effort pin +
 * its credential profile env. Errors (unknown runtime, unconfigured or
 * unsafe profile) are returned, never launched without the profile.
 */
export function buildLaunchCommand(
  runtime: string,
  opts: { model?: string | null; effort?: string | null; profile?: string | null; resume?: boolean },
): Result<string> {
  const runtimeConfig = getConfig().runtimes[runtime];
  if (!runtimeConfig) return { ok: false, error: `Unknown runtime '${runtime}'` };
  const env = resolveProfileEnv(runtime, opts.profile);
  if (!env.ok) return env;
  return { ok: true, data: buildRuntimeCommand(runtimeConfig, { model: opts.model, effort: opts.effort, env: env.data, resume: opts.resume }) };
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

/**
 * After a worktree is created: run the matching project's `setup_command`
 * there (npm ci …), detached, logging to `<worktree>/.wavecode-setup.log`.
 * Returns the command when one was started so the caller can tell the agent.
 */
export function runWorkspaceSetup(workspace: string, agentId: string): string | null {
  const cfg = getConfig();
  const project = Object.entries(cfg.projects ?? {}).find(([, p]) => p.setup_command && workspaceMatches(workspace, p.workspace_match));
  if (!project) return null;
  const [name, p] = project;
  const command = p.setup_command!.trim();
  const log = path.join(workspace, '.wavecode-setup.log');
  try {
    const out = fs.openSync(log, 'a');
    const child = spawn('sh', ['-c', `${command}; echo "[wavecode-setup exit $?]"`], { cwd: workspace, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    emit('agent.workspace_setup', 'agent', agentId, { project: name, command, log, status: 'started' });
    child.on('exit', (code) => {
      emit('agent.workspace_setup', 'agent', agentId, { project: name, command, log, status: code === 0 ? 'done' : 'failed', exit_code: code });
    });
    return command;
  } catch (e) {
    emit('agent.workspace_setup', 'agent', agentId, { project: name, command, log, status: 'failed', error: (e as Error).message });
    return null;
  }
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
  profile?: string | null;
  /** Session recreated for an agent that ran before: resume its conversation. */
  resume?: boolean;
}): Result<void> {
  const command = buildLaunchCommand(opts.runtime, opts);
  if (!command.ok) return command;

  try {
    // newSession creates a shell first, then sends the command as keystrokes
    // so the session survives even if the command fails
    tmux.newSession(opts.sessionName, opts.workDir, command.data);

    return { ok: true, data: undefined };
  } catch (e) {
    return { ok: false, error: `Failed to create tmux session: ${(e as Error).message}` };
  }
}
