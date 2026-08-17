/**
 * Per-run orchestrate result file.
 *
 * Last line must be exactly `RESULT: PASS` or `RESULT: FAIL`.
 * A one-line reason sits above that line. Missing, unparseable, or
 * pane-only text is never PASS. WaveCode never invents PASS from idle,
 * duration, or TUI copy such as "reviewed by another AI".
 *
 * This is the run/orchestrate signal. Referee / wavepulse-gate RESULT
 * remains the promote gate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';

export const RESULT_PASS_LINE = 'RESULT: PASS';
export const RESULT_FAIL_LINE = 'RESULT: FAIL';

export type RunResultVerdict = 'PASS' | 'FAIL';

export interface ParsedRunResult {
  verdict: RunResultVerdict;
  reason: string;
  lastLine: string;
}

export interface PresentedRunResult {
  result_path: string | null;
  result: RunResultVerdict | null;
  result_reason: string | null;
  result_last_line: string | null;
}

const EXACT_RESULT_LINE = /^RESULT: (PASS|FAIL)$/;

export function runResultRelPath(runId: string): string {
  return path.join('.wavecode', 'runs', runId, 'result.txt');
}

export function fallbackResultRoot(): string {
  try {
    const root = getConfig().paths.transcripts_root;
    if (root && root.trim()) return root;
  } catch {
    // Config not loaded (unit tests) — keep leftovers out of the repo.
  }
  return path.join(os.tmpdir(), 'wavecode-run-results');
}

/** Stable absolute path for a run's result file. */
export function resolveRunResultPath(runId: string, workspace?: string | null): string {
  if (workspace && workspace.trim()) {
    return path.join(workspace, runResultRelPath(runId));
  }
  return path.join(fallbackResultRoot(), 'runs', runId, 'result.txt');
}

export function parseRunResultText(text: string): ParsedRunResult | null {
  const lines = text.split(/\r?\n/);
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) return null;

  const lastLine = lines[lastIdx].trim();
  const match = lastLine.match(EXACT_RESULT_LINE);
  if (!match) return null;

  let reason = '';
  for (let i = lastIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 0) {
      reason = trimmed.replace(/^REASON:\s*/i, '');
      break;
    }
  }

  return {
    verdict: match[1] as RunResultVerdict,
    reason,
    lastLine,
  };
}

export function readRunResult(filePath: string | null | undefined): ParsedRunResult | null {
  if (!filePath) return null;
  try {
    return parseRunResultText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function oneLineReason(reason: string, verdict: RunResultVerdict): string {
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  if (collapsed) return collapsed;
  return verdict === 'PASS' ? 'Completed' : 'No parseable RESULT file';
}

export function writeRunResult(
  filePath: string,
  verdict: RunResultVerdict,
  reason: string,
): ParsedRunResult {
  const line = oneLineReason(reason, verdict);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${line}\nRESULT: ${verdict}\n`, 'utf8');
  return { verdict, reason: line, lastLine: `RESULT: ${verdict}` };
}

export function ensureRunResultDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * Honor a valid agent-written file. Otherwise write FAIL.
 * Never upgrades missing/unparseable/pane text to PASS.
 */
export function settleRunResultFile(
  filePath: string,
  fallbackReason: string,
  opts?: { forceFail?: boolean },
): ParsedRunResult {
  const existing = readRunResult(filePath);
  if (opts?.forceFail) {
    if (existing?.verdict === 'FAIL') return existing;
    return writeRunResult(filePath, 'FAIL', fallbackReason);
  }
  if (existing) return existing;
  return writeRunResult(filePath, 'FAIL', fallbackReason);
}

export function exitCodeForVerdict(verdict: RunResultVerdict | null | undefined): number {
  return verdict === 'PASS' ? 0 : 1;
}

export function resultPathForRun(
  run: { id: string; result_path?: string | null },
  workspace?: string | null,
): string {
  if (run.result_path) return run.result_path;
  return resolveRunResultPath(run.id, workspace);
}

export function presentRunResult(filePath: string | null | undefined): PresentedRunResult {
  const parsed = readRunResult(filePath);
  return {
    result_path: filePath ?? null,
    result: parsed?.verdict ?? null,
    result_reason: parsed?.reason ?? null,
    result_last_line: parsed?.lastLine ?? null,
  };
}

export function presentRun<T extends { result_path?: string | null }>(run: T): T & PresentedRunResult {
  return { ...run, ...presentRunResult(run.result_path) };
}

export function buildRunResultBriefing(resultPath: string): string {
  const relHint = resultPath.includes(`${path.sep}.wavecode${path.sep}`)
    ? resultPath.slice(resultPath.indexOf(`${path.sep}.wavecode${path.sep}`) + 1)
    : resultPath;
  return [
    '## WAVECODE RUN RESULT',
    'Before you go idle, write this file (do not only print in the terminal, and do not paste shell/netcat into the TUI):',
    `  ${resultPath}`,
    `Relative path: ${relHint}`,
    '',
    'Last line must be exactly:',
    RESULT_PASS_LINE,
    'or',
    RESULT_FAIL_LINE,
    '',
    'Put a one-line reason on the line above (not a pane dump). Example:',
    'Reviewed auth.ts; 2 issues remain',
    RESULT_FAIL_LINE,
  ].join('\n');
}

export function appendRunResultBriefing(prompt: string, resultPath: string): string {
  return `${prompt}\n\n${buildRunResultBriefing(resultPath)}`;
}
