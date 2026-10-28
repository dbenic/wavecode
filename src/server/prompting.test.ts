import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendKeys = vi.fn(async () => ({ ok: true as const, data: undefined }));
vi.mock('./session-manager.js', () => ({ sendKeys: (...a: unknown[]) => sendKeys(...a) }));
const state = { value: 'alive' as 'alive' | 'dead' | 'unknown' };
vi.mock('./runtime-liveness.js', () => ({ RUNTIME_NOT_RUNNING: 'runtime not running', getRuntimeState: vi.fn(async () => state.value) }));
const trackPrompt = vi.fn(async () => undefined);
vi.mock('./reply-capture.js', () => ({ trackPrompt: (...a: unknown[]) => trackPrompt(...a) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ projects: {}, paths: {}, artifacts: { storage: '' }, review: {} })) }));

import * as db from './db.js';
import { promptAgent } from './prompting.js';

describe('promptAgent', () => {
  let tmp: string;
  let agent: db.Agent;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-prompting-'));
    db.initDb(path.join(tmp, 't.db'));
    agent = db.insertAgent({ name: 'toni', runtime: 'claude-code', tmux_session: 'wc-toni', workspace: tmp, mode: 'spawned', status: 'idle' }).data!;
    db.getDb().prepare("UPDATE agents SET alias = 'toni', persona = 'frontend lead' WHERE id = ?").run(agent.id);
    agent = db.getAgent(agent.id).data!;
    sendKeys.mockClear(); trackPrompt.mockClear(); state.value = 'alive';
  });
  afterEach(() => { db.resetDbForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('types the persona-prefixed line, records the prompt event with the actor and tracks the reply', async () => {
    const r = await promptAgent({ agent, actorId: 'user-1', text: 'fix the header' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.typed).toBe('[you are @toni — frontend lead] fix the header');
    expect(sendKeys).toHaveBeenCalledWith(agent.id, r.typed);
    const ev = db.getDb().prepare("SELECT id, actor_id, payload_json FROM events WHERE type = 'agent.prompt_sent'").get() as { id: number; actor_id: string; payload_json: string };
    expect(ev.actor_id).toBe('user-1');
    expect(JSON.parse(ev.payload_json).text).toBe('fix the header');
    expect(r.prompt_event_id).toBe(ev.id);
    expect(trackPrompt).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'user-1', prompt: r.typed, promptEventId: ev.id }));
  });

  it('a seat\'s prompt is typed with the instruction prefix, shown unprefixed in the thread, and its reply tracked for the seat', async () => {
    const r = await promptAgent({ agent, actorId: 'user-1', text: 'start the Hipsl script now', seat: { handle: 'pm-denis', owner: 'denis' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.typed).toBe("[you are @toni — frontend lead] [from @pm-denis, denis's PM seat: this is your instruction, not relayed material] start the Hipsl script now");
    const ev = db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'agent.prompt_sent'").get() as { payload_json: string };
    expect(JSON.parse(ev.payload_json).text).toBe('start the Hipsl script now');
    expect(trackPrompt).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'user-1', viaSeat: true }));
  });

  it('refuses a dead runtime with 409 and types nothing', async () => {
    state.value = 'dead';
    const r = await promptAgent({ agent, actorId: null, text: 'hello' });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('does not track a reply for a TUI command', async () => {
    const r = await promptAgent({ agent, actorId: null, text: '/model' });
    expect(r.ok).toBe(true);
    expect(trackPrompt).not.toHaveBeenCalled();
  });
});
