import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const paths: { inbox_watch?: string[] } = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ paths })) }));

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
    expect(typed).toBe(`[File from deploy/fable] ${file} — read it and act on it as part of your current task; answer with a TO @fable: line if it asks a question.`);
    expect(db.listAgentMessages({ to_agent_id: claude.id })[0]).toMatchObject({ message_type: 'handoff', from_agent_id: null });
    // the same file (same mtime) is never announced twice
    announceFile(file, 'deploy/fable');
    expect(vi.mocked(sessionManager.sendKeys)).toHaveBeenCalledTimes(1);
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
    fs.writeFileSync(path.join(dir, 'claude1-new.md'), 'new');
    await new Promise((r) => setTimeout(r, 1600));
    const typed = vi.mocked(sessionManager.sendKeys).mock.calls.filter((c) => c[0] === claude.id).map((c) => c[1] as string);
    expect(typed.some((t) => t.includes('claude1-new.md'))).toBe(true);
    expect(typed.some((t) => t.includes('claude1-old.md'))).toBe(false);
  });
});
