import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import * as db from './db.js';
import { forgetGitMemoInMemoryForTest, gitAncestor, gitMemoStats, gitRun, loadGitMemo, MEMO_MAX_ENTRIES, resetGitMemoForTest, setGitExecForTest } from './git-memo.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('git memo persistence', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-git-memo-'));
    db.initDb(path.join(tmp, 't.db'));
    resetGitMemoForTest();
  });
  afterEach(() => {
    resetGitMemoForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('an answer about full SHAs survives a restart: restored from the table, git is not asked again', async () => {
    let calls = 0;
    loadGitMemo();
    setGitExecForTest(async () => { calls++; return { stdout: '', status: 0 }; });
    expect(await gitAncestor('/repo', A, B)).toBe(true);
    expect(calls).toBe(1);
    expect(db.getDb().prepare('SELECT count(*) AS n FROM git_memo').get()).toEqual({ n: 1 });

    forgetGitMemoInMemoryForTest(); // the daemon stops
    expect(gitMemoStats().entries).toBe(0);
    expect(loadGitMemo()).toBe(1);
    expect(await gitAncestor('/repo', A, B)).toBe(true);
    expect(calls).toBe(1);
  });

  it('a branch-name lookup and a failed answer are not persisted', async () => {
    loadGitMemo();
    setGitExecForTest(async (_repo, args) => (args.includes('rev-parse') ? { stdout: A, status: 0 } : { stdout: null, status: 128 }));
    await gitRun('/repo', ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
    await gitRun('/repo', ['merge-base', '--is-ancestor', A, B]);
    expect(db.getDb().prepare('SELECT count(*) AS n FROM git_memo').get()).toEqual({ n: 0 });
  });

  it('the table is kept to the memo size: the oldest rows go', async () => {
    loadGitMemo();
    setGitExecForTest(async () => ({ stdout: '', status: 0 }));
    for (let i = 0; i < MEMO_MAX_ENTRIES + 5; i++) {
      await gitRun('/repo', ['merge-base', '--is-ancestor', A, String(i).padStart(40, '0')]);
    }
    expect(db.getDb().prepare('SELECT count(*) AS n FROM git_memo').get()).toEqual({ n: MEMO_MAX_ENTRIES });
    const first = `/repo\0merge-base\0--is-ancestor\0${A}\0${'0'.repeat(40)}`;
    expect(db.getDb().prepare('SELECT key FROM git_memo WHERE key = ?').get(first)).toBeUndefined();
  });
});
