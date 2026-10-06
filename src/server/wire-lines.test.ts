import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import * as db from './db.js';
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import { detectWireLines, onAgentIdle, resetWireLinesForTest } from './wire-lines.js';

let tmp: string;
beforeEach(() => {
  vi.clearAllMocks();
  resetWireLinesForTest();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-wire-'));
  db.initDb(path.join(tmp, 't.db'));
});
afterEach(() => { db.resetDbForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

function agent(name: string, status: 'idle' | 'working' = 'idle', alias?: string): db.Agent {
  const r = db.insertAgent({ name, runtime: 'codex', tmux_session: `wc-${name}`, workspace: `/w/${name}`, mode: 'spawned', status });
  if (!r.ok) throw new Error(r.error);
  if (alias) db.updateAgentIdentity(r.data.id, { alias });
  return db.getAgent(r.data.id).data!;
}

describe('TO @agent lines', () => {
  it('delivers a TO line as a handoff message into the recipient (idle) once, recorded in the thread', () => {
    const codex = agent('codex1', 'idle', 'codex1');
    const claude = agent('claude1');
    const pane = [
      '• Spec written to /home/wave/inbox/spec.md',
      '    TO @claude1: please review /home/wave/inbox/spec.md and answer with VERDICT: PASS|NEEDS FIXES', // the rules example
      'TO @claude1: please review /home/wave/inbox/codex1-product-desk-user-access-20261006.md and reply with VERDICT: PASS or NEEDS FIXES',
      'TO @nobody: hello',
      '› ',
    ].join('\n');
    detectWireLines(codex.id, pane);
    detectWireLines(codex.id, pane);
    const typed = vi.mocked(sessionManager.sendKeys).mock.calls;
    expect(typed.filter((c) => c[0] === claude.id)).toHaveLength(1);
    expect(typed.find((c) => c[0] === claude.id)?.[1]).toBe('[Message from @codex1] please review /home/wave/inbox/codex1-product-desk-user-access-20261006.md and reply with VERDICT: PASS or NEEDS FIXES');
    expect(typed.find((c) => c[0] === codex.id)?.[1]).toMatch(/^\[TO @nobody failed: no such agent/);
    const msgs = db.listAgentMessages({ to_agent_id: claude.id });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from_agent_id: codex.id, message_type: 'handoff' });
    expect(vi.mocked(emit).mock.calls.filter((c) => c[0] === 'message.created')).toHaveLength(1);
  });

  it('waits while the recipient is working and delivers on its idle edge', () => {
    const codex = agent('codex1');
    const claude = agent('claude1', 'working');
    detectWireLines(codex.id, 'TO @claude1: when you are free, run the VAT tests on wc-codex1');
    expect(vi.mocked(sessionManager.sendKeys)).not.toHaveBeenCalled();
    db.updateAgentStatus(claude.id, 'idle');
    onAgentIdle(claude.id);
    expect(vi.mocked(sessionManager.sendKeys)).toHaveBeenCalledWith(claude.id, '[Message from @codex1] when you are free, run the VAT tests on wc-codex1');
  });
});
