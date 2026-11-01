import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = {
  projects: {
    wave: { workspace_match: '**/wave*', pipeline: { auto_stage_main: true, auto_stage_main_min_minutes: 10 } },
    quiet: { workspace_match: '**/quiet*', pipeline: { auto_stage_main: false } },
  },
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => cfg) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const bus = { listeners: [] as Array<(e: unknown) => void> };
vi.mock('./event-bus.js', () => ({
  emit: vi.fn(() => ({ id: 1 })),
  onEvent: vi.fn((l: (e: unknown) => void) => { bus.listeners.push(l); return () => { bus.listeners.splice(bus.listeners.indexOf(l), 1); }; }),
}));

const deploy = {
  open: [] as Array<{ status: string }>,
  tip: { state: 'peer', source: 'peer', tip: null } as { state: 'peer' | 'unknown' | 'local'; source: 'peer'; tip: { sha: string; version: null; lane: null } | null },
};
vi.mock('./releases.js', () => ({
  listReleases: vi.fn(() => deploy.open),
  resolveStagingTip: vi.fn(async () => deploy.tip),
  requestRelease: vi.fn(async (o: { sha: string }) => ({ ok: true, data: { id: `R-${o.sha.slice(0, 4)}` } })),
}));

import { emit } from './event-bus.js';
import { requestRelease } from './releases.js';
import {
  MAIN_STAGING_ACTOR,
  noteMainAdvanced,
  pendingMainTip,
  resetMainStagingForTest,
  stageMainTick,
  startMainStaging,
} from './main-staging.js';

const M1 = '1'.repeat(40);
const M2 = '2'.repeat(40);
const L1 = 'a'.repeat(40);
const T0 = Date.parse('2026-11-01T12:00:00Z');
const MIN = 60_000;

function merged(project: string, laneSha: string, mainSha: string, lane = 'wc-claude2') {
  for (const l of bus.listeners) {
    l({ id: 1, type: 'merge_queue.merged', entity_type: 'run', entity_id: laneSha, payload_json: JSON.stringify({ project, lane, sha_in: laneSha, sha_out: mainSha }), actor_id: null, created_at: '' });
  }
}

describe('staging follows main', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMainStagingForTest();
    deploy.open = [];
    deploy.tip = { state: 'peer', source: 'peer', tip: null };
    cfg.projects.wave.pipeline = { auto_stage_main: true, auto_stage_main_min_minutes: 10 };
    startMainStaging();
  });

  it('a queue merge requests a staging release of the new main tip, as wavecode, naming the lane', async () => {
    merged('wave', L1, M1);
    expect(pendingMainTip('wave')).toBe(M1);
    await stageMainTick(T0);
    expect(requestRelease).toHaveBeenCalledTimes(1);
    expect(requestRelease).toHaveBeenCalledWith({ project: 'wave', sha: M1, target: 'staging', actorName: MAIN_STAGING_ACTOR, note: `main after queue merge of wc-claude2 ${L1.slice(0, 8)}` });
    expect(pendingMainTip('wave')).toBeNull();
    expect(emit).toHaveBeenCalledWith('staging.main_requested', 'release', 'R-1111', expect.objectContaining({ project: 'wave', sha: M1, lane: 'wc-claude2' }), null);
  });

  it('two merges before the tick coalesce into one request for the newest tip', async () => {
    merged('wave', L1, M1);
    merged('wave', 'b'.repeat(40), M2, 'wc-codex3');
    await stageMainTick(T0);
    expect(requestRelease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestRelease).mock.calls[0][0].sha).toBe(M2);
  });

  it('paces requests: a tip that arrives inside the window waits for the next window', async () => {
    merged('wave', L1, M1);
    await stageMainTick(T0);
    merged('wave', 'b'.repeat(40), M2);
    await stageMainTick(T0 + 5 * MIN);
    expect(requestRelease).toHaveBeenCalledTimes(1);
    expect(pendingMainTip('wave')).toBe(M2);
    await stageMainTick(T0 + 10 * MIN);
    expect(requestRelease).toHaveBeenCalledTimes(2);
    expect(vi.mocked(requestRelease).mock.calls[1][0].sha).toBe(M2);
  });

  it('waits while a staging release is open, then requests when it has finished', async () => {
    deploy.open = [{ status: 'sent' }];
    merged('wave', L1, M1);
    await stageMainTick(T0);
    expect(requestRelease).not.toHaveBeenCalled();
    expect(pendingMainTip('wave')).toBe(M1);
    deploy.open = [{ status: 'deployed' }];
    await stageMainTick(T0 + MIN);
    expect(requestRelease).toHaveBeenCalledTimes(1);
  });

  it('drops a tip that staging already shows, without a request', async () => {
    deploy.tip = { state: 'peer', source: 'peer', tip: { sha: M1, version: null, lane: null } };
    merged('wave', L1, M1);
    await stageMainTick(T0);
    expect(requestRelease).not.toHaveBeenCalled();
    expect(pendingMainTip('wave')).toBeNull();
  });

  it('keeps the tip while the deploy box cannot be asked for its staging tip', async () => {
    deploy.tip = { state: 'unknown', source: 'peer', tip: null };
    merged('wave', L1, M1);
    await stageMainTick(T0);
    expect(requestRelease).not.toHaveBeenCalled();
    expect(pendingMainTip('wave')).toBe(M1);
  });

  it('a refused request is recorded as skipped and not retried with the same tip', async () => {
    vi.mocked(requestRelease).mockResolvedValueOnce({ ok: false, error: 'behind main: merge main' });
    merged('wave', L1, M1);
    await stageMainTick(T0);
    expect(emit).toHaveBeenCalledWith('staging.main_skipped', 'release', M1, expect.objectContaining({ error: 'behind main: merge main' }), null);
    expect(pendingMainTip('wave')).toBeNull();
  });

  it('does nothing for a project without the flag, and ignores other events and bad SHAs', async () => {
    merged('quiet', L1, M1);
    noteMainAdvanced('wave', 'not-a-sha');
    for (const l of bus.listeners) l({ id: 2, type: 'release.reported', entity_type: 'release', entity_id: 'x', payload_json: '{}', actor_id: null, created_at: '' });
    await stageMainTick(T0);
    expect(requestRelease).not.toHaveBeenCalled();
    expect(pendingMainTip('quiet')).toBeNull();
    expect(pendingMainTip('wave')).toBeNull();
  });

  it('the window can be set to zero minutes for back-to-back staging', async () => {
    cfg.projects.wave.pipeline = { auto_stage_main: true, auto_stage_main_min_minutes: 0 };
    merged('wave', L1, M1);
    await stageMainTick(T0);
    merged('wave', 'b'.repeat(40), M2);
    await stageMainTick(T0);
    expect(requestRelease).toHaveBeenCalledTimes(2);
  });
});
