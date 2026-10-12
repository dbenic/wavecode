import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('./task-dispatcher.js', () => ({ dispatchNext: vi.fn(), unblockDependentsPublic: vi.fn(), onRunComplete: vi.fn(), finalizeRun: vi.fn() }));

const cfg = {
  projects: {} as Record<string, { workspace_match: string; tests?: { queue_command?: string[]; quick_suites?: string[]; full_suites?: string[] } }>,
  releases: {} as { deploy_agent?: string },
  peers: {} as Record<string, unknown>,
  review: { auto_review: false, default_reviewer: 'x', self_review: true, max_fix_loops: 2, require_pass_to_promote: false, gate_dependents_on_approval: false, auto_pick: true, freeze_inbox: [] as string[] },
  artifacts: { storage: '', retention_days: 30 },
  paths: {},
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => cfg) }));

import * as db from './db.js';
import * as releases from './releases.js';
import * as freezes from './release-freezes.js';
import { setTestRunExecForTest } from './test-runs.js';

const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';

describe('automatic quick and full gates', () => {
  let tmp: string;
  const queued: string[][] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-auto-gate-'));
    cfg.artifacts.storage = path.join(tmp, 'store');
    cfg.projects = {};
    cfg.releases = { deploy_agent: 'fable' };
    db.initDb(path.join(tmp, 't.db'));
    releases.ensureReleaseTables();
    freezes.ensureReleaseFreezeTable();
    db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: path.join(tmp, 'ws'), mode: 'adopted', status: 'idle' });
    db.insertAgent({ name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: path.join(tmp, 'deploy'), mode: 'adopted', status: 'idle' });
    queued.length = 0;
    setTestRunExecForTest((argv) => { queued.push(argv); return ''; });
  });

  afterEach(() => {
    setTestRunExecForTest(null);
    releases.stopReleasePollers();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function freezeNote(): string {
    const file = path.join(tmp, `desk91-freeze-${SHA.slice(0, 8)}.md`);
    fs.writeFileSync(file, `# Desk #91 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`wc-claude2\`\n- Freeze SHA: \`${SHA}\`\n`);
    return file;
  }

  it('queues the configured quick suite once when a freeze is ingested', () => {
    cfg.projects.wavepulse = { workspace_match: '**/ws/*', tests: { queue_command: ['test-queue', '{suite}', '{sha}', '{lane}'], quick_suites: ['tier1'] } };
    expect(freezes.ingestFreezeFile(freezeNote()).ok).toBe(true);
    expect(queued).toEqual([['test-queue', 'tier1', SHA, 'wc-claude2']]);
    expect(freezes.ingestFreezeFile(freezeNote()).ok).toBe(true);
    expect(queued).toHaveLength(1);
  });

  it('queues one full gate when the SHA lands on staging, and not again for production', () => {
    cfg.projects.wavepulse = {
      workspace_match: '**/ws/*',
      tests: { queue_command: ['test-queue', '{suite}', '{sha}', '{lane}'], full_suites: ['nightly'] },
    };
    const stage = () => releases.acceptRelease(
      { sha: SHA, lane: 'wc-claude2', target: 'staging', project: 'wavepulse', requested_by: 'owner' },
      { userName: 'owner', fromPeer: false },
    );
    const first = stage();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(releases.reportRelease(first.data.id, { status: 'deployed', version: '1.2.3' }).ok).toBe(true);
    expect(queued).toEqual([['test-queue', 'nightly', SHA, 'wc-claude2']]);

    const second = stage();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(releases.reportRelease(second.data.id, { status: 'deployed' }).ok).toBe(true);
    expect(queued).toHaveLength(1);

    const prod = releases.acceptRelease(
      { sha: SHA, lane: 'wc-claude2', target: 'production', project: 'wavepulse', requested_by: 'owner' },
      { userName: 'owner', fromPeer: false },
    );
    expect(prod.ok).toBe(true);
    if (!prod.ok) return;
    expect(releases.reportRelease(prod.data.id, { status: 'deployed' }).ok).toBe(true);
    expect(queued).toHaveLength(1);
  });

  it('does not run a queue command that is not configured', () => {
    cfg.projects.wavepulse = { workspace_match: '**/ws/*' };
    expect(freezes.ingestFreezeFile(freezeNote()).ok).toBe(true);
    expect(queued).toEqual([]);
  });
});
