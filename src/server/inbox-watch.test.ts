import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const paths: { inbox_watch?: string[] } = {};
const artifacts = { storage: '', retention_days: 30 };
const review: { freeze_inbox?: string[] } = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ paths, artifacts, review, projects: {} })) }));

import * as db from './db.js';
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import { announceFile, resetInboxWatchForTest, startInboxWatchers, watchedInboxDirs } from './inbox-watch.js';
import { resetWireLinesForTest } from './wire-lines.js';

let tmp: string;
beforeEach(() => {
  vi.clearAllMocks();
  resetInboxWatchForTest(); resetWireLinesForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-inbox-'));
  db.initDb(path.join(tmp, 't.db'));
  paths.inbox_watch = [path.join(tmp, 'from-fable')];
  artifacts.storage = path.join(tmp, 'store');
  review.freeze_inbox = undefined;
});
afterEach(() => { resetInboxWatchForTest(); db.resetDbForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

function agent(name: string, status: 'idle' | 'working' = 'idle', alias?: string): db.Agent {
  const r = db.insertAgent({ name, runtime: 'codex', tmux_session: `wc-${name}`, workspace: `/w/${name}`, mode: 'spawned', status });
  if (!r.ok) throw new Error(r.error);
  if (alias) db.updateAgentIdentity(r.data.id, { alias });
  return db.getAgent(r.data.id).data!;
}

describe('hand-off folder watcher', () => {
  it('a new file addressed by a "To:" line is announced into that agent\'s pane and recorded as a handoff message', () => {
    const claude = agent('claude1');
    const dir = path.join(tmp, 'from-fable'); fs.mkdirSync(dir);
    const file = path.join(dir, 'release-notes-20261008.md');
    fs.writeFileSync(file, 'To: @claude1\n\nDeployed 0.440.71; please verify invoice 3176.');
    announceFile(file, 'deploy/fable');
    const typed = vi.mocked(sessionManager.sendKeys).mock.calls.find((c) => c[0] === claude.id)?.[1] as string;
    // the hand-off is archived as a library document and the announcement names the kept copy
    const doc = db.listArtifacts({ kind: 'document' })[0];
    expect(doc).toMatchObject({ filename: 'release-notes-20261008.md', note: 'To: @claude1' });
    expect(doc.provenance).toBe(`hand-off from deploy/fable; archived from ${file}`);
    expect(typed).toBe(`[File from deploy/fable] ${file} (archive ${doc.storage_path}) — read it and act on it as part of your current task; answer with a TO @fable: line if it asks a question.`);
    expect(db.listAgentMessages({ to_agent_id: claude.id })[0]).toMatchObject({ message_type: 'handoff', from_agent_id: null });
    // the same file (same mtime) is never announced twice
    announceFile(file, 'deploy/fable');
    expect(vi.mocked(sessionManager.sendKeys)).toHaveBeenCalledTimes(1);
  });

  it('announces a heading that names several agents, and skips a name that does not resolve', () => {
    const a = agent('ales-codex1');
    const b = agent('ales-claude1');
    const dir = path.join(tmp, 'from-fable'); fs.mkdirSync(dir);
    const file = path.join(dir, 'maestro-note.md');
    fs.writeFileSync(file, '# Maestro → @ales-codex1, @ales-claude1, @missing-agent: please look\n');
    announceFile(file, 'deploy/fable');
    const sent = vi.mocked(sessionManager.sendKeys).mock.calls.map((c) => c[0]);
    expect(sent).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(sent).toHaveLength(2);
  });

  it('picks the longest hyphen-prefix of the file name that resolves', () => {
    agent('ales');
    const codex = agent('ales-codex1');
    const dir = path.join(tmp, 'from-fable'); fs.mkdirSync(dir);
    const file = path.join(dir, 'ales-codex1-foo.md');
    fs.writeFileSync(file, 'no address line\n');
    announceFile(file, 'deploy/fable');
    expect(vi.mocked(sessionManager.sendKeys).mock.calls.map((c) => c[0])).toEqual([codex.id]);
  });

  it('posts an unrouted hand-off when nothing resolves', () => {
    const dir = path.join(tmp, 'from-fable'); fs.mkdirSync(dir);
    const file = path.join(dir, 'general-notice.md');
    fs.writeFileSync(file, 'To: @nobody-known\n\nhello\n');
    announceFile(file, 'deploy/fable');
    const info = vi.mocked(emit).mock.calls.find((c) => c[0] === 'message.created');
    expect(info?.[3]).toMatchObject({ unrouted: true, notice: 'unrouted hand-off' });
    const row = db.listAgentMessages({ limit: 5 })[0];
    expect(row.message.startsWith('unrouted hand-off:')).toBe(true);
  });

  it('falls back to the file name prefix, waits for a working agent, and posts unaddressed files to the thread', () => {
    const codex = agent('codex1', 'working', 'codex1');
    const dir = path.join(tmp, 'from-fable'); fs.mkdirSync(dir);
    const forCodex = path.join(dir, 'codex1-probe-results.md');
    fs.writeFileSync(forCodex, '# results\n');
    announceFile(forCodex, 'deploy/fable');
    expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled(); // queued until idle
    expect(db.listAgentMessages({ to_agent_id: codex.id })).toHaveLength(1);

    const nobody = path.join(dir, 'general-notice.md');
    fs.writeFileSync(nobody, 'hello team');
    announceFile(nobody, 'deploy/fable');
    const info = vi.mocked(emit).mock.calls.find((c) => c[0] === 'message.created' && (c[3] as { via?: string }).via === 'inbox_watch');
    expect(info?.[3]).toMatchObject({ file: nobody, message_type: 'info' });
  });

  it('startInboxWatchers creates the folder, ignores files already present, and announces new ones', async () => {
    const claude = agent('claude1');
    const dir = path.join(tmp, 'from-fable'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'claude1-old.md'), 'old');
    expect(watchedInboxDirs()).toEqual([dir]);
    startInboxWatchers();
    // fs.watch on macOS attaches asynchronously: a write in the first moments can be missed under a
    // loaded full-suite run, so give it a beat, then re-touch the file while polling (settle is 1.2 s).
    await new Promise((r) => setTimeout(r, 300));
    const newFile = path.join(dir, 'claude1-new.md');
    fs.writeFileSync(newFile, 'new');
    const calls = () => vi.mocked(sessionManager.sendKeys).mock.calls.filter((c) => c[0] === claude.id).map((c) => c[1] as string);
    const deadline = Date.now() + 8000;
    let lastTouch = Date.now();
    while (!calls().some((t) => t.includes('claude1-new.md')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      if (Date.now() - lastTouch > 2000) { fs.appendFileSync(newFile, '\n'); lastTouch = Date.now(); }
    }
    const typed = calls();
    expect(typed.some((t) => t.includes('claude1-new.md'))).toBe(true);
    expect(typed.some((t) => t.includes('claude1-old.md'))).toBe(false);
  }, 10000);
});

describe('shared inbox routing', () => {
  it('"<author>-to-<recipient>-…" goes to the recipient, never to the author', () => {
    const codex6 = agent('codex6');
    const codex3 = agent('codex3');
    const dir = path.join(tmp, 'from-fable'); fs.mkdirSync(dir);
    const file = path.join(dir, 'codex6-to-codex3-four-lanes-main-sync-review-20261025.md');
    fs.writeFileSync(file, '# four lanes\n\nplease review the sync\n');
    announceFile(file, 'inbox');
    expect(vi.mocked(sessionManager.sendKeys).mock.calls.map((c) => c[0])).toEqual([codex3.id]);
    expect(db.listAgentMessages({ to_agent_id: codex6.id })).toHaveLength(0);

    // An unknown recipient after "-to-" is unrouted, not handed back to the author.
    const stray = path.join(dir, 'codex6-to-maestro-status.md');
    fs.writeFileSync(stray, 'status\n');
    announceFile(stray, 'inbox');
    expect(vi.mocked(sessionManager.sendKeys).mock.calls.map((c) => c[0])).toEqual([codex3.id]);
    expect(db.listAgentMessages({ limit: 10 }).some((m) => m.message.startsWith('unrouted hand-off:') && m.message.includes('codex6-to-maestro'))).toBe(true);
  });

  it('in a freeze inbox only addressed text files are announced; logs, freezes and verdicts are left alone; first-pass files are recorded', () => {
    const codex3 = agent('codex3');
    const codex7 = agent('codex7');
    const dir = path.join(tmp, 'inbox'); fs.mkdirSync(dir);
    review.freeze_inbox = [dir];
    paths.inbox_watch = [dir];
    const write = (name: string, body: string) => { const f = path.join(dir, name); fs.writeFileSync(f, body); announceFile(f, 'inbox'); return f; };
    write('codex7-brain-5a0cfed62-evidence-20261025.md', '# evidence\n');
    write('codex8-review-brief91-ee371cf23-quick-20261025.log', 'RESULT: PASS\n');
    write('codex7-freeze-5a0cfed62-20261025.md', '# freeze\nFreeze SHA: 5a0cfed62\n');
    write('codex3-verdict-codex7-5a0cfed62-20261025.md', 'VERDICT: PASS\n');
    expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled();
    expect(db.listAgentMessages({ limit: 10 })).toHaveLength(0);

    write('codex7-to-codex3-four-lanes-20261025.md', '# sync\n');
    write('maestro-note-20261025.md', 'To: @codex3\n\nplease look\n');
    expect(vi.mocked(sessionManager.sendKeys).mock.calls.map((c) => c[0])).toEqual([codex3.id, codex3.id]);
    expect(db.listAgentMessages({ to_agent_id: codex7.id })).toHaveLength(0);

    const fp = write('wave-firstpass-5a0cfed6-20261025.md', '# First pass\nSHA: 5a0cfed62e4f1b2c3d4e5f60718293a4b5c6d7e8\nSeat: @codex3\nISSUES:\n- [MED] a.ts:1 — x\nFIRST PASS: PASS\n');
    expect(vi.mocked(sessionManager.sendKeys)).toHaveBeenCalledTimes(2);
    const recorded = vi.mocked(emit).mock.calls.find((c) => c[0] === 'pipeline.first_pass');
    expect(recorded?.[2]).toBe('5a0cfed62e4f1b2c3d4e5f60718293a4b5c6d7e8');
    expect(recorded?.[3]).toMatchObject({ result: 'pass', issues: 1, seat: 'codex3', file: fp });
  });
});
