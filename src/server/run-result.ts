/**
 * One small per-run result file under the WaveCode data dir.
 *
 * Path: runs/<run_id>/result.txt
 * Written once at the end (overwrite, capped). Orchestrate reads this
 * file by run_id only — never tmux, never a transcript scrape.
 *
 * Last line must be exactly `RESULT: PASS` or `RESULT: FAIL`, with a
 * one-line reason above it. Missing or unparseable is not PASS.
 * WaveCode never invents PASS from idle or TUI chrome. If the agent
 * did not write a valid RESULT, WaveCode may overwrite with FAIL or
 * leave the file missing.
 *
 * The file is the source of truth. API fields are a convenience.
 * Referee / wavepulse-gate RESULT remains the promote gate.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';

export const RESULT_PASS_LINE = 'RESULT: PASS';
export const RESULT_FAIL_LINE = 'RESULT: FAIL';
/** Hard cap so the result file cannot grow. */
export const RESULT_FILE_MAX_BYTES = 4096;
export const RESULT_REASON_MAX_CHARS = 240;

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

export function getRunsRoot(): string {
  try {
    const transcripts = getConfig().paths.transcripts_root;
    if (transcripts && transcripts.trim()) {
      return path.join(path.dirname(transcripts), 'runs');
    }
  } catch {
    // Config not loaded (unit tests) — keep leftovers out of the repo.
  }
  return path.join(os.tmpdir(), 'wavecode-run-results', 'runs');
}

export function runResultRelPath(runId: string): string {
  return path.join('runs', runId, 'result.txt');
}

/** Stable path: <data-dir>/runs/<run_id>/result.txt */
export function resolveRunResultPath(runId: string, _workspace?: string | null): string {
  return path.join(getRunsRoot(), runId, 'result.txt');
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
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const size = Number(stat.size);
      if (size <= 0) return null;
      const readLen = Math.min(size, RESULT_FILE_MAX_BYTES);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, Math.max(0, size - readLen));
      return parseRunResultText(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function oneLineReason(reason: string, verdict: RunResultVerdict): string {
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  const fallback = verdict === 'PASS' ? 'Completed' : 'No parseable RESULT file';
  const text = collapsed || fallback;
  return text.length > RESULT_REASON_MAX_CHARS
    ? text.slice(0, RESULT_REASON_MAX_CHARS)
    : text;
}

/** Overwrite the small result file. Never append-forever. */
export function writeRunResult(
  filePath: string,
  verdict: RunResultVerdict,
  reason: string,
): ParsedRunResult {
  const line = oneLineReason(reason, verdict);
  const body = `${line}\nRESULT: ${verdict}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
  return { verdict, reason: line, lastLine: `RESULT: ${verdict}` };
}

export function ensureRunResultDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function resultFileBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Honor a valid last-line RESULT. Otherwise overwrite with a small FAIL.
 * Never upgrades missing/unparseable/pane text to PASS.
 * Rewrite if the file grew past the cap.
 */
export function settleRunResultFile(
  filePath: string,
  fallbackReason: string,
  opts?: { forceFail?: boolean },
): ParsedRunResult {
  const existing = readRunResult(filePath);
  const oversized = resultFileBytes(filePath) > RESULT_FILE_MAX_BYTES;
  if (opts?.forceFail) {
    if (existing?.verdict === 'FAIL' && !oversized) return existing;
    return writeRunResult(filePath, 'FAIL', fallbackReason);
  }
  if (existing) {
    if (oversized) return writeRunResult(filePath, existing.verdict, existing.reason);
    return existing;
  }
  return writeRunResult(filePath, 'FAIL', fallbackReason);
}

export function exitCodeForVerdict(verdict: RunResultVerdict | null | undefined): number {
  return verdict === 'PASS' ? 0 : 1;
}

export function resultPathForRun(
  run: { id: string; result_path?: string | null },
  _workspace?: string | null,
): string {
  if (run.result_path) return run.result_path;
  return resolveRunResultPath(run.id);
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
  return [
    '## WAVECODE RUN RESULT',
    'Before you go idle, write this small file once (overwrite, do not append, do not only print in the terminal, and do not paste shell/netcat into the TUI):',
    `  ${resultPath}`,
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
