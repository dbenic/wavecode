/**
 * Async git for the review board. Commands whose every revision is a full
 * SHA are memoized: the same lane tip and main tip do not run merge-base,
 * rev-list, or diff again. Branch-name lookups stay uncached so a moved
 * tip is noticed on the next refresh.
 */

import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string | null;
  status: number | null;
}

type GitExec = (repo: string, args: string[], timeout: number) => Promise<GitResult>;

/**
 * Bounded: at most MEMO_MAX_ENTRIES results, none larger than MEMO_MAX_BYTES
 * (a full lane diff can be megabytes; thousands of freezes would turn the
 * memo into the daemon's biggest allocation). Oldest entries go first.
 */
export const MEMO_MAX_ENTRIES = 4000;
export const MEMO_MAX_BYTES = 256 * 1024;
const memo = new Map<string, GitResult>();
let custom: GitExec | null = null;

function remember(key: string, result: GitResult): void {
  if ((result.stdout?.length ?? 0) > MEMO_MAX_BYTES) return;
  if (memo.has(key)) memo.delete(key);
  memo.set(key, result);
  while (memo.size > MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

/** Entries held and their text size, for the Health panel. */
export function gitMemoStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const r of memo.values()) bytes += r.stdout?.length ?? 0;
  return { entries: memo.size, bytes };
}

function isFullSha(text: string): boolean {
  return /^[0-9a-f]{40}$/i.test(text);
}

function isShaRange(text: string): boolean {
  const parts = text.split(/\.{2,3}/);
  return parts.length === 2 && parts.every((part) => isFullSha(part));
}

/** True when the output depends only on object ids, not on a branch moving. */
export function gitArgsCacheable(args: string[]): boolean {
  if (args.includes('fetch') || args.includes('for-each-ref') || args.includes('rev-parse')) return false;
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const revisions = positional.slice(1);
  if (revisions.length === 0) return false;
  return revisions.every((arg) => isFullSha(arg) || isShaRange(arg));
}

function memoKey(repo: string, args: string[]): string {
  return `${repo}\0${args.join('\0')}`;
}

export function resetGitMemoForTest(): void {
  memo.clear();
  custom = null;
}

export function setGitExecForTest(fn: GitExec | null): void {
  custom = fn;
  memo.clear();
}

/** execFile reports a non-zero exit on `error.code`, not `error.status`. A timeout leaves both unset. */
function exitCode(err: Error | null): number | null {
  if (!err) return 0;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === 'number') return code;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function defaultExec(repo: string, args: string[], timeout: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout) => {
      const status = exitCode(err);
      const text = String(stdout ?? '').trim();
      resolve({ stdout: text || (status === 0 ? '' : null), status });
    });
  });
}

export async function gitRun(repo: string, args: string[], timeout = 8000): Promise<GitResult> {
  const key = memoKey(repo, args);
  if (gitArgsCacheable(args)) {
    const hit = memo.get(key);
    if (hit) return hit;
  }
  const result = await (custom ?? defaultExec)(repo, args, timeout);
  if (gitArgsCacheable(args) && result.status !== null) remember(key, result);
  return result;
}

export async function gitText(repo: string, args: string[], timeout = 8000): Promise<string | null> {
  const result = await gitRun(repo, args, timeout);
  if (result.status !== 0) return null;
  return result.stdout;
}

/** `merge-base --is-ancestor`. Null when git cannot say (timeout, missing object). */
export async function gitAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const result = await gitRun(repo, ['merge-base', '--is-ancestor', ancestor, descendant], 5000);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}
