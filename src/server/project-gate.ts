/**
 * Per-project verify/referee profile.
 *
 * When an agent's workspace matches a configured project that has a gate,
 * WaveCode invokes that project's referee command and treats its RESULT line
 * as the only completion/promote evidence. Agent self-report and the LLM
 * `verify_completion` path are never evidence for such a project.
 *
 * The referee cds itself to a shared checkout. This module must not pass a
 * worktree cwd (unpushed worktrees are invisible to the gate).
 */

import { execFile, type ExecFileException } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, type ProjectConfig } from './config.js';
import { getDb, type Agent, type Result } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';

export const GATE_FULL_TIMEOUT_MS = 70 * 60 * 1000;
const GATE_KV_PREFIX = 'gate_result:';
const SAFE_COMMAND = /^[a-zA-Z0-9._/-]+$/;
const SAFE_BRANCH = /^[a-zA-Z0-9._/-]+$/;

export interface GateResultRecord {
  result_line: string | null;
  log_path: string | null;
  exit_code: number;
  mode: 'fast' | 'full';
  branch: string;
  sha: string | null;
  checked_at: string;
}

export interface ParsedResultLine {
  verdict: 'GREEN' | 'RED';
  branch: string;
  sha: string;
  lint: 'PASS' | 'FAIL';
  unit: 'PASS' | 'FAIL';
  frontend: 'PASS' | 'FAIL';
  apiStrict?: 'PASS' | 'FAIL';
  raw: string;
}

export interface MatchedProject {
  name: string;
  config: ProjectConfig;
}

export type GateExec = (
  command: string,
  args: string[],
  opts: { timeout: number; encoding: 'utf8'; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

let gateExec: GateExec = defaultGateExec;

export function setGateExecForTest(fn: GateExec | null): void {
  gateExec = fn ?? defaultGateExec;
}

function defaultGateExec(
  command: string,
  args: string[],
  opts: { timeout: number; encoding: 'utf8'; maxBuffer: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(command, args, opts, (err, stdout, stderr) => {
      const execErr = err as ExecFileException | null;
      let exitCode = 0;
      if (execErr) {
        if (execErr.code === 'ETIMEDOUT' || execErr.killed) {
          exitCode = 2;
        } else if (typeof execErr.code === 'number') {
          exitCode = execErr.code;
        } else {
          exitCode = 2;
        }
      }
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exitCode,
      });
    });
  });
}

export function findGatedProject(workspace: string | null | undefined): MatchedProject | null {
  if (!workspace) return null;
  const projects = getConfig().projects ?? {};
  for (const [name, project] of Object.entries(projects)) {
    if (!project?.gate?.command || !project.workspace_match) continue;
    if (workspaceMatches(workspace, project.workspace_match)) {
      return { name, config: project };
    }
  }
  return null;
}

export function projectRequiresReferee(workspace: string | null | undefined): boolean {
  return findGatedProject(workspace) !== null;
}

export function workspaceMatches(workspace: string, pattern: string): boolean {
  const ws = workspace.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');
  if (!/[*?]/.test(pat)) {
    const prefix = pat.replace(/\/+$/, '');
    return ws === prefix || ws.startsWith(`${prefix}/`);
  }
  return globToRegExp(pat).test(ws);
}

export function globToRegExp(glob: string): RegExp {
  let i = 0;
  let out = '^';
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob[i] === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 2;
      if (glob[i] === '/') i += 1;
      continue;
    }
    if (glob[i] === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (glob[i] === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegex(glob[i]);
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

const RESULT_RE =
  /^RESULT\s+(GREEN|RED)\s+branch=(\S+)\s+sha=([0-9a-fA-F]{8})\s+lint=(PASS|FAIL)\s+unit=(PASS|FAIL)\s+frontend=(PASS|FAIL)(?:\s+api-strict=(PASS|FAIL))?/;

export function parseResultLine(text: string): ParsedResultLine | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(RESULT_RE);
    if (!match) continue;
    return {
      verdict: match[1] as 'GREEN' | 'RED',
      branch: match[2],
      sha: match[3].toLowerCase(),
      lint: match[4] as 'PASS' | 'FAIL',
      unit: match[5] as 'PASS' | 'FAIL',
      frontend: match[6] as 'PASS' | 'FAIL',
      apiStrict: match[7] as 'PASS' | 'FAIL' | undefined,
      raw: line.trim(),
    };
  }
  return null;
}

export function parseLogPath(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^log:\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

/** Failing test file paths from a referee log (`FAIL  tests/api/....ts`). */
export function parseFailingFiles(logText: string): string[] {
  const files = new Set<string>();
  for (const line of logText.split(/\r?\n/)) {
    const match = line.match(/^FAIL\s+(\S+)/);
    if (!match) continue;
    const token = match[1].replace(/:$/, '');
    if (token.includes('/') || /\.(ts|js|tsx|jsx|mjs|cjs)$/.test(token)) {
      files.add(token);
    }
  }
  return [...files];
}

export function firstAssertionFromLog(logText: string): string | null {
  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      /^(Error|AssertionError|TypeError|ReferenceError)\b/.test(trimmed) ||
      /\bexpected\b.+\b(to|got)\b/i.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return null;
}

export function gateResultKey(runId: string): string {
  return `${GATE_KV_PREFIX}${runId}`;
}

export function storeGateResult(runId: string, record: GateResultRecord): void {
  getDb().prepare(
    'INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(gateResultKey(runId), JSON.stringify(record));
}

export function getStoredGateResult(runId: string): GateResultRecord | null {
  const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?')
    .get(gateResultKey(runId)) as { value: string } | undefined;
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as GateResultRecord;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function expandHomeDir(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function newestMatchingLog(globPath: string): string | null {
  const expanded = expandHomeDir(globPath);
  const dir = path.dirname(expanded);
  const filePat = path.basename(expanded);
  if (!fs.existsSync(dir)) return null;
  const re = globToRegExp(filePat);
  const matches: Array<{ full: string; mtime: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    if (!re.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) matches.push({ full, mtime: stat.mtimeMs });
    } catch {
      // skip unreadable entries
    }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.full ?? null;
}

export function resolveBaselineLog(project: ProjectConfig): string | null {
  const gate = project.gate;
  if (!gate) return null;
  if (gate.baseline_glob) return newestMatchingLog(gate.baseline_glob);
  const sanitized = gate.branch.replaceAll('/', '-');
  return newestMatchingLog(path.join(os.homedir(), 'gate-results', `${sanitized}-*-full.log`));
}

function resolveBranch(project: ProjectConfig, agentName?: string): string {
  if (agentName && project.agent_branches?.[agentName]) {
    return project.agent_branches[agentName];
  }
  return project.gate!.branch;
}

/**
 * After run.finished: if the workspace matches a gated project, invoke the
 * referee (full mode) and persist the RESULT. Never calls the LLM verifier.
 */
export async function maybeInvokeProjectGate(runId: string, agent: Agent): Promise<GateResultRecord | null> {
  const matched = findGatedProject(agent.workspace);
  if (!matched?.config.gate) return null;

  const gate = matched.config.gate;
  const branch = resolveBranch(matched.config, agent.name);
  const mode: 'fast' | 'full' = 'full';

  if (!SAFE_COMMAND.test(gate.command) || !SAFE_BRANCH.test(branch)) {
    const record: GateResultRecord = {
      result_line: null,
      log_path: null,
      exit_code: 2,
      mode,
      branch,
      sha: null,
      checked_at: new Date().toISOString(),
    };
    storeGateResult(runId, record);
    logger.warn(
      { runId, project: matched.name, command: gate.command, branch },
      'Referee command or branch failed safety check — stored FATAL',
    );
    emit('gate.checked', 'run', runId, {
      project: matched.name,
      exit_code: 2,
      result_line: null,
    });
    return record;
  }

  logger.info(
    { runId, project: matched.name, branch, mode, command: gate.command },
    'Invoking project referee (shared checkout; no worktree cwd)',
  );

  // Intentionally omit cwd — the referee cds to its shared checkout.
  // WaveCode must not run the gate against ~/.wavecode-data/worktrees/*.
  const { stdout, exitCode } = await gateExec(gate.command, [branch, mode], {
    timeout: GATE_FULL_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  const parsed = parseResultLine(stdout);
  const logPath = parseLogPath(stdout);
  const record: GateResultRecord = {
    result_line: parsed?.raw ?? null,
    log_path: logPath,
    exit_code: exitCode,
    mode,
    branch: parsed?.branch ?? branch,
    sha: parsed?.sha ?? null,
    checked_at: new Date().toISOString(),
  };
  storeGateResult(runId, record);

  emit('gate.checked', 'run', runId, {
    project: matched.name,
    exit_code: exitCode,
    result_line: record.result_line,
    sha: record.sha,
    branch: record.branch,
    log_path: record.log_path,
  });

  logger.info(
    { runId, project: matched.name, exitCode, sha: record.sha, result: record.result_line },
    'Project referee finished',
  );
  return record;
}

/**
 * Promote gate: RESULT is the only evidence. A human "known-red" override
 * cannot substitute for a missing/FATAL RESULT.
 */
export function evaluateRefereeForPromote(
  runId: string,
  workspace: string | null | undefined,
): Result<void> {
  const matched = findGatedProject(workspace);
  if (!matched?.config.gate) return { ok: true, data: undefined };

  const stored = getStoredGateResult(runId);
  if (!stored || !stored.result_line) {
    return {
      ok: false,
      error: 'Promotion blocked: no referee RESULT for this run',
    };
  }

  if (stored.exit_code === 2) {
    return {
      ok: false,
      error: ['Promotion blocked: referee FATAL (exit 2)', stored.result_line].join('\n'),
    };
  }

  const parsed = parseResultLine(stored.result_line);
  if (!parsed) {
    return {
      ok: false,
      error: 'Promotion blocked: unparseable referee RESULT for this run',
    };
  }

  if (parsed.verdict === 'GREEN') {
    return { ok: true, data: undefined };
  }

  const bounce = bounceTextForRed(stored, matched.config);
  if (bounce) return { ok: false, error: bounce };
  return { ok: true, data: undefined };
}

export function bounceTextForRed(stored: GateResultRecord, project: ProjectConfig): string | null {
  const thisLog = readLog(stored.log_path);
  if (!thisLog) {
    const lines = [stored.result_line ?? 'RESULT RED'];
    if (stored.log_path) lines.push(`log: ${stored.log_path}`);
    return lines.join('\n');
  }

  const thisFiles = parseFailingFiles(thisLog);
  const baselinePath = resolveBaselineLog(project);
  const baselineFiles = new Set(baselinePath ? parseFailingFiles(readLog(baselinePath) ?? '') : []);
  const newFiles = thisFiles.filter((f) => !baselineFiles.has(f));

  if (newFiles.length === 0) return null;

  const lines = [stored.result_line ?? 'RESULT RED'];
  for (const file of newFiles) lines.push(file);
  const assertion = firstAssertionFromLog(thisLog);
  if (assertion) lines.push(assertion);
  return lines.join('\n');
}

function readLog(logPath: string | null): string | null {
  if (!logPath) return null;
  try {
    return fs.readFileSync(logPath, 'utf-8');
  } catch {
    return null;
  }
}
