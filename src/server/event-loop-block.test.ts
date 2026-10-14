/**
 * Spawn, send, and a watcher tick must keep the loop free even when tmux
 * and git take hundreds of milliseconds. A synchronous exec would show up
 * as a heartbeat gap over 100 ms.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SLOW_MS = 150;

vi.mock('node:child_process', () => {
  const busy = (ms: number) => {
    const start = Date.now();
    while (Date.now() - start < ms) { /* sync exec would freeze the page */ }
  };
  return {
    execFile: (_file: string, _args: string[], opts: unknown, cb?: (err: null, stdout: string, stderr: string) => void) => {
      const callback = typeof opts === 'function' ? opts as typeof cb : cb;
      setTimeout(() => callback?.(null, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', ''), SLOW_MS);
      return { stdin: { end() {} } };
    },
    execFileSync: () => { busy(SLOW_MS); return ''; },
    execSync: () => { busy(SLOW_MS); return ''; },
    spawnSync: () => { busy(SLOW_MS); return { status: 0, stdout: '' }; },
    spawn: () => ({ unref() {}, kill() {}, on() {} }),
  };
});

import { initDb, resetDbForTest } from './db.js';
import { gitText } from './git-memo.js';
import { runWatcherBatchForTest, startWatching, stopAll } from './output-watcher.js';
import { newSession, sendTextAndEnter } from './tmux.js';
import { app } from './app.js';

async function maxGapDuring(work: Promise<unknown>): Promise<number> {
  let last = Date.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    max = Math.max(max, now - last);
    last = now;
  }, 10);
  try {
    await work;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    clearInterval(timer);
  }
  return max;
}

describe('event loop stays free while tmux and git are slow', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-loop-'));

  afterEach(() => {
    stopAll();
    resetDbForTest();
  });

  it('does not block for more than 100 ms during spawn, send, a watcher tick, or GET /', async () => {
    initDb(path.join(tmp, 'wavecode.db'));
    const db = (await import('./db.js')).getDb();
    db.prepare(
      `INSERT INTO agents (id, name, runtime, tmux_session, mode, status) VALUES (?, ?, ?, ?, 'spawned', 'working')`,
    ).run('agt-loop', 'loop', 'claude-code', 'wc-loop');
    startWatching('agt-loop');

    const spawnGap = await maxGapDuring(newSession('wc-loop', tmp, 'echo hi'));
    const sendGap = await maxGapDuring(sendTextAndEnter('wc-loop', 'please look at the diff'));
    const watchGap = await maxGapDuring(runWatcherBatchForTest());
    const gitGap = await maxGapDuring(gitText(tmp, ['rev-parse', 'HEAD']));

    const pending = newSession('wc-other', tmp, 'echo still-going');
    const t0 = Date.now();
    const res = await app.request('/');
    const indexMs = Date.now() - t0;
    await pending;

    expect(spawnGap).toBeLessThan(100);
    expect(sendGap).toBeLessThan(100);
    expect(watchGap).toBeLessThan(100);
    expect(gitGap).toBeLessThan(100);
    expect(indexMs).toBeLessThan(100);
    expect(res.status).toBeLessThan(500);
  }, 20_000);
});
