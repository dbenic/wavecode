/**
 * Async git for the review board. Commands whose every revision is a full
 * SHA are memoized: the same lane tip and main tip do not run merge-base,
 * rev-list, or diff again. Branch-name lookups stay uncached so a moved
 * tip is noticed on the next refresh.
 */

import { execFile } from 'node:child_process';
import { getDb } from './db.js';
import logger from './logger.js';

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
/** 4,000 was the cap until 28 Oct 2026; the boards hit it the same day (FIFO eviction, every pass re-asked). About 240 bytes a row. */
export const MEMO_MAX_ENTRIES = 20_000;
export const MEMO_MAX_BYTES = 256 * 1024;
const memo = new Map<string, GitResult>();
let custom: GitExec | null = null;
/** Write-through to the git_memo table (the daemon turns it on after initDb; tests leave it off). */
let persist = false;

function remember(key: string, result: GitResult): void {
  if ((result.stdout?.length ?? 0) > MEMO_MAX_BYTES) return;
  if (memo.has(key)) memo.delete(key);
  memo.set(key, result);
  const evicted: string[] = [];
  while (memo.size > MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
    evicted.push(oldest);
  }
  if (!persist) return;
  try {
    const db = getDb();
    db.prepare('INSERT INTO git_memo (key, status, stdout) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, stdout = excluded.stdout, created_at = datetime(\'now\')')
      .run(key, result.status ?? 0, result.stdout);
    if (evicted.length) {
      const del = db.prepare('DELETE FROM git_memo WHERE key = ?');
      for (const k of evicted) del.run(k);
    }
  } catch (e) {
    logger.debug({ error: (e as Error).message }, 'git memo row not written');
  }
}

/**
 * Startup: reload the answers the daemon had before it stopped and keep writing new ones. Every
 * entry is a fact about immutable SHAs (gitArgsCacheable, exit 0/1), so an old answer is still
 * right. 28 Oct 2026: with an empty memo the lane board and the deploy reconcile spawned about
 * 20 merge-base/cherry a second for half an hour after each restart.
 */
export function loadGitMemo(): number {
  persist = true;
  let rows: Array<{ key: string; status: number; stdout: string | null }> = [];
  try {
    const db = getDb();
    const n = (db.prepare('SELECT count(*) AS n FROM git_memo').get() as { n: number }).n;
    if (n > MEMO_MAX_ENTRIES) {
      db.prepare('DELETE FROM git_memo WHERE rowid IN (SELECT rowid FROM git_memo ORDER BY rowid ASC LIMIT ?)').run(n - MEMO_MAX_ENTRIES);
    }
    rows = db.prepare('SELECT key, status, stdout FROM git_memo ORDER BY rowid ASC').all() as typeof rows;
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'git memo not loaded');
    return 0;
  }
  memo.clear();
  for (const r of rows) memo.set(r.key, { stdout: r.stdout, status: r.status });
  logger.info({ entries: memo.size }, 'git memo restored');
  return memo.size;
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
  negative.clear();
  custom = null;
  persist = false;
}

/** Tests: drop what is in memory but keep the rows, as a daemon stop does. */
export function forgetGitMemoInMemoryForTest(): void {
  memo.clear();
  negative.clear();
}

export function setGitExecForTest(fn: GitExec | null): void {
  custom = fn;
  memo.clear();
  negative.clear();
}

/** execFile reports a non-zero exit on `error.code`, not `error.status`. A timeout leaves both unset. */
function exitCode(err: Error | null): number | null {
  if (!err) return 0;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === 'number') return code;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/**
 * Ancestry and existence reads never need blob content. In a partial clone (blob:none) git would
 * otherwise try to fetch a missing commit from the remote on every such call: 28 Oct 2026, six
 * freezes on commits nobody pushed cost three remote round trips each, five times a second.
 */
const NO_LAZY_FETCH = new Set(['merge-base', 'cherry', 'rev-list', 'cat-file', 'rev-parse']);

function execEnv(args: string[]): NodeJS.ProcessEnv | undefined {
  const sub = args.find((a) => !a.startsWith('-'));
  return sub && NO_LAZY_FETCH.has(sub) ? { ...process.env, GIT_NO_LAZY_FETCH: '1' } : undefined;
}

function defaultExec(repo: string, args: string[], timeout: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      ...(execEnv(args) ? { env: execEnv(args) } : {}),
    }, (err, stdout) => {
      const status = exitCode(err);
      const text = String(stdout ?? '').trim();
      resolve({ stdout: text || (status === 0 ? '' : null), status });
    });
  });
}

/** A failed answer (missing object, timeout) is remembered this long; a later fetch may change it. */
export const NEGATIVE_TTL_MS = 10 * 60_000;
const negative = new Map<string, { until: number; result: GitResult }>();

export async function gitRun(repo: string, args: string[], timeout = 8000): Promise<GitResult> {
  const key = memoKey(repo, args);
  const cacheable = gitArgsCacheable(args);
  if (cacheable) {
    const hit = memo.get(key);
    if (hit) return hit;
    const neg = negative.get(key);
    if (neg) {
      if (neg.until > Date.now()) return neg.result;
      negative.delete(key);
    }
  }
  const result = await (custom ?? defaultExec)(repo, args, timeout);
  if (cacheable) {
    // Exit 0 and 1 are answers (is-ancestor yes/no, cherry output) about immutable SHAs: kept.
    // Anything else (128 missing object, null timeout) is asked again after the TTL.
    if (result.status === 0 || result.status === 1) remember(key, result);
    else negative.set(key, { until: Date.now() + NEGATIVE_TTL_MS, result });
  }
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
