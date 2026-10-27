import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg: Record<string, unknown> = { releases: { production_approvers: ['denis'] } };
vi.mock('./config.js', () => ({ getConfig: () => cfg }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import * as db from './db.js';
import { findSlackGo, seatProductionAllowed, goNote } from './slack-go.js';

const SHA = 'a78dda9394f5595106b09bffa79c429231888a43';
const T0 = Date.UTC(2026, 9, 27, 19, 0, 0);
let tmp: string;
let denis: db.User;
let ales: db.User;

function prompt(minutesAgo: number, actorId: string | null, text: string): number {
  const at = new Date(T0 - minutesAgo * 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const r = db.getDb().prepare("INSERT INTO events (type, entity_type, entity_id, payload_json, actor_id, created_at) VALUES ('agent.prompt_sent', 'agent', 'a1', ?, ?, ?)").run(JSON.stringify({ text }), actorId, at);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-go-'));
  db.initDb(path.join(tmp, 't.db'));
  const mk = (name: string, role: string) => {
    const id = `01USER${name.toUpperCase().padEnd(20, 'X')}`;
    db.getDb().prepare('INSERT INTO users (id, name, role, color, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, role, '#000', `h-${name}`, '2026-10-01 00:00:00');
    return db.getUser(id).data!;
  };
  denis = mk('denis', 'admin');
  ales = mk('ales', 'developer');
  cfg.releases = { production_approvers: ['denis'] };
});

afterEach(() => {
  try { db.closeDb?.(); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Slack GO for a seat production request', () => {
  it('finds the approver\'s own Slack message that names the SHA and says GO for production', () => {
    const id = prompt(3, denis.id, `[from Slack DM, denis; answer for Slack: short] GO: push ${SHA} to production, run 20261027-195233, PASS files attached`);
    const go = findSlackGo(denis.id, SHA, T0);
    expect(go).toMatchObject({ event_id: id, user_name: 'denis' });
    expect(go!.excerpt).toContain('GO: push a78dda93');
    const allowed = seatProductionAllowed({ id: denis.id, name: 'denis', via_seat: true }, SHA, T0);
    expect(allowed.ok).toBe(true);
    expect(goNote(go!)).toMatch(/^GO by @denis in Slack at 18:57 UTC \(event \d+\)/);
  });

  it('accepts the short SHA and the words push / deploy with prod', () => {
    prompt(1, denis.id, `[from Slack DM, denis] please deploy ${SHA.slice(0, 8)} to prod now`);
    expect(findSlackGo(denis.id, SHA, T0)).not.toBeNull();
  });

  it('refuses: no message, old message, another person, no SHA, no production word, not from Slack, non-admin, not an approver', () => {
    expect(seatProductionAllowed({ id: denis.id, name: 'denis', via_seat: true }, SHA, T0).ok).toBe(false);
    prompt(16, denis.id, `[from Slack DM, denis] GO ${SHA} production`);
    expect(findSlackGo(denis.id, SHA, T0)).toBeNull();
    prompt(2, ales.id, `[from Slack DM, ales] GO ${SHA} production`);
    expect(findSlackGo(denis.id, SHA, T0)).toBeNull();
    expect(seatProductionAllowed({ id: ales.id, name: 'ales', via_seat: true }, SHA, T0).error).toContain('not an admin');
    prompt(2, denis.id, '[from Slack DM, denis] GO production for the bank posting');
    expect(findSlackGo(denis.id, SHA, T0)).toBeNull();
    prompt(2, denis.id, `[from Slack DM, denis] push ${SHA} to staging`);
    expect(findSlackGo(denis.id, SHA, T0)).toBeNull();
    prompt(2, denis.id, `[Admin note] GO ${SHA} production`); // typed through the UI or a file, not Slack
    expect(findSlackGo(denis.id, SHA, T0)).toBeNull();
    prompt(2, denis.id, `[from Slack DM, denis] GO ${SHA} production`);
    cfg.releases = { production_approvers: ['someone-else'] };
    expect(seatProductionAllowed({ id: denis.id, name: 'denis', via_seat: true }, SHA, T0).error).toContain('production_approvers');
    expect(seatProductionAllowed({ id: denis.id, name: 'denis', via_seat: false }, SHA, T0).error).toBe('not a seat token');
  });

  it('a GO quoted by the seat in its own prompt does not count: the actor is the seat\'s person only for Slack prompts', () => {
    prompt(2, null, `[from Slack DM, denis] GO ${SHA} production`); // system actor
    expect(findSlackGo(denis.id, SHA, T0)).toBeNull();
  });
});
