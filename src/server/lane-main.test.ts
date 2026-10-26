import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const projects: Record<string, { repo?: string; workspace_match?: string; lane_glob?: string; pipeline?: { review_deny?: string[]; lane_deny?: string[]; agent_deny?: string[] } }> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ projects, paths: {}, artifacts: { storage: '' }, review: {} })) }));

import * as db from './db.js';
import { alertBehind, alertLanesPastStaging, alertMerged, behindMainAlert, commitsBehind, isMergeOnlyDelta, LANE_RETIRED, laneHasNothingMainLacks, MAIN_PING, mergedMainAlert, observeRepo, pingLaneAboutMain, reconcileBehindFreezes, resetLaneRetireMemoForTest, setLaneAlertNowForTest, withRefMemoAsync } from './lane-main.js';
import { ensureReleaseFreezeTable } from './release-freezes.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

describe('lane main ancestry', () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lane-main-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    projects.wave = { repo, workspace_match: '**/*', lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    git(repo, 'checkout', '-q', '-b', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane work');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', git(repo, 'rev-parse', 'HEAD'));
    db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-ales', workspace: repo, mode: 'spawned', status: 'idle' });
  });

  afterEach(() => {
    setLaneAlertNowForTest(null);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
  });

  it('counts zero when the lane contains main, then the commits main gained', async () => {
    const lane = git(repo, 'rev-parse', 'wc-ales');
    expect((await commitsBehind('wave', lane))).toBe(0);
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    expect((await commitsBehind('wave', lane))).toBe(1);
  });

  it('inside one board pass the main tip is resolved once, so every card sees the same main; outside a pass a move is seen at once', async () => {
    const lane = git(repo, 'rev-parse', 'wc-ales');
    const seen = await withRefMemoAsync(async () => {
      const before = (await commitsBehind('wave', lane));
      git(repo, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(repo, 'm.txt'), 'm');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'main moved');
      git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
      return { before, during: (await commitsBehind('wave', lane)) };
    });
    expect(seen).toEqual({ before: 0, during: 0 });
    expect((await commitsBehind('wave', lane))).toBe(1);
  });

  it('pings an author once per main SHA', async () => {
    const lane = git(repo, 'rev-parse', 'wc-ales');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm1');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first advance');
    const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', first);
    db.getDb().prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?)').run('main_tip:wave', lane);
    (await observeRepo(repo));
    const pings = () => db.getDb().prepare('SELECT entity_id, payload_json FROM events WHERE type = ?').all(MAIN_PING) as { entity_id: string; payload_json: string }[];
    expect(pings()).toHaveLength(1);
    expect(pings()[0].entity_id).toBe(`wc-ales:${first}`);
    expect(JSON.parse(pings()[0].payload_json).kind).toBe('moved');
    const messages = db.listAgentMessages({ limit: 10 });
    expect(messages.some((m) => m.message.includes('Your lane wc-ales is behind main.'))).toBe(true);
    (await observeRepo(repo));
    expect(pings()).toHaveLength(1);
    expect((await pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha: first, kind: 'freeze' }))).toBe(false);
  });

  it('treats a clean merge of main as a merge-only delta, and a further lane commit as not', async () => {
    const oldSha = git(repo, 'rev-parse', 'wc-ales');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'main-only');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main feature');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', 'merge main', 'origin/main');
    const merged = git(repo, 'rev-parse', 'HEAD');
    expect((await isMergeOnlyDelta(repo, oldSha, merged, 'origin/main'))).toBe(true);
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'more');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'more lane work');
    expect((await isMergeOnlyDelta(repo, oldSha, git(repo, 'rev-parse', 'HEAD'), 'origin/main'))).toBe(false);
  });

  it('repeats the behind alert after 30 minutes only while the lane is still behind and unreviewed', async () => {
    let now = 1_700_000_000_000;
    setLaneAlertNowForTest(() => now);
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'later');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    const oldLane = git(repo, 'rev-parse', 'wc-ales');
    const ping = async () => (await pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha, kind: 'moved' }));
    expect((await ping())).toBe(true);
    expect((await ping())).toBe(false);
    now += 30 * 60 * 1000;
    expect((await ping())).toBe(true);
    const rows = () => db.getDb().prepare('SELECT payload_json FROM events WHERE type = ?').all(MAIN_PING) as { payload_json: string }[];
    expect(rows()).toHaveLength(2);
    expect(rows().every((row) => JSON.parse(row.payload_json).kind === 'moved')).toBe(true);
    const messages = db.listAgentMessages({ limit: 10 }).map((m) => m.message);
    expect(messages.filter((m) => m === behindMainAlert('wc-ales'))).toHaveLength(2);

    ensureReleaseFreezeTable();
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, verdict, status) VALUES (?, 'wave', 'wc-ales', 'pass', 'open')`,
    ).run(oldLane);
    now += 30 * 60 * 1000;
    expect((await ping())).toBe(true);

    db.getDb().prepare('DELETE FROM release_freezes').run();
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, verdict, status) VALUES (?, 'wave', 'wc-ales', 'pass', 'open')`,
    ).run(mainSha);
    now += 30 * 60 * 1000;
    expect((await ping())).toBe(false);
  });

  it('does not ping a denied lane or its agent', async () => {
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'wc-codex1');
    fs.writeFileSync(path.join(repo, 'codex.txt'), 'codex');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'codex lane');
    const laneSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-codex1', laneSha);
    const codex = db.insertAgent({ name: 'codex1', runtime: 'codex', tmux_session: 'wc-codex1', workspace: repo, mode: 'spawned', status: 'idle' });
    if (!codex.ok) throw new Error(codex.error);
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'moved');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    projects.wave.pipeline = { lane_deny: ['wc-codex1'], agent_deny: ['codex1'] };
    projects.wave.lane_glob = 'wc-ales';
    expect((await pingLaneAboutMain({ lane: 'wc-codex1', project: 'wave', mainSha, kind: 'moved' }))).toBe(false);
    expect((await alertBehind({ lane: 'wc-codex1', project: 'wave' }))).toBe(false);
    expect((await alertMerged({ lane: 'wc-codex1', project: 'wave', mainSha }))).toBe(false);
    ensureReleaseFreezeTable();
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, author_name, status) VALUES (?, 'wave', 'wc-codex1', 'codex1', 'open')`,
    ).run(laneSha);
    (await alertLanesPastStaging('wave', mainSha));
    const pings = db.getDb().prepare('SELECT entity_id FROM events WHERE type = ?').all(MAIN_PING) as { entity_id: string }[];
    expect(pings.some((row) => row.entity_id.startsWith('wc-codex1:'))).toBe(false);
    expect(pings.some((row) => row.entity_id.startsWith('wc-ales:'))).toBe(true);
    const sent = db.listAgentMessages({ to_agent_id: codex.data.id }).map((row) => row.message);
    expect(sent).toEqual([]);
  });

  it('uses the auto-merge sentence and does not also send the behind alert', async () => {
    const mainSha = git(repo, 'rev-parse', 'origin/main');
    expect((await alertMerged({ lane: 'wc-ales', project: 'wave', mainSha }))).toBe(true);
    const messages = db.listAgentMessages({ limit: 5 }).map((m) => m.message);
    expect(messages).toContain(mergedMainAlert('wc-ales'));
    expect(messages.some((m) => m.includes('behind main'))).toBe(false);
    expect((await pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha, kind: 'moved' }))).toBe(false);
  });

  it('does not ping a review_deny agent by name or alias', async () => {
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'wc-codex1');
    fs.writeFileSync(path.join(repo, 'codex.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'codex lane');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-codex1', git(repo, 'rev-parse', 'HEAD'));
    const seat = db.insertAgent({
      name: 'chatgpt-countix', runtime: 'codex', tmux_session: 'wc-codex1', workspace: repo, mode: 'spawned', status: 'idle',
    });
    if (!seat.ok) throw new Error(seat.error);
    db.updateAgentIdentity(seat.data.id, { alias: 'codex1' });
    projects.wave.pipeline = { review_deny: ['codex1'] };

    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'advance');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    db.getDb().prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?)').run('main_tip:wave', git(repo, 'rev-parse', 'wc-ales'));
    (await observeRepo(repo));

    const pings = db.getDb().prepare('SELECT entity_id FROM events WHERE type = ?').all(MAIN_PING) as { entity_id: string }[];
    expect(pings.map((row) => row.entity_id)).toEqual([`wc-ales:${mainSha}`]);
    const seatText = db.listAgentMessages({ to_agent_id: seat.data.id }).map((row) => row.message).join('\n');
    expect(seatText).not.toMatch(/behind main|Merged latest main/);
    expect((await pingLaneAboutMain({
      lane: 'wc-codex1', project: 'wave', mainSha, kind: 'moved', authorAgentId: seat.data.id, authorName: 'codex1',
    }))).toBe(false);
    expect((await pingLaneAboutMain({
      lane: 'wc-codex1', project: 'wave', mainSha, kind: 'merged', authorName: 'chatgpt-countix',
    }))).toBe(false);

    projects.wave.pipeline = { review_deny: ['chatgpt-countix'] };
    expect((await pingLaneAboutMain({
      lane: 'wc-codex1', project: 'wave', mainSha, kind: 'freeze', authorAgentId: seat.data.id,
    }))).toBe(false);
    expect(db.listAgentMessages({ to_agent_id: seat.data.id }).map((row) => row.message).join('\n')).not.toMatch(/behind main|Merged latest main/);
  });

  it('a merge-only tip is not a nudge, and the same lane is not nudged twice inside 30 minutes', async () => {
    ensureReleaseFreezeTable();
    const ales = db.listAgents().find((a) => a.name === 'ales')!;
    const oldSha = git(repo, 'rev-parse', 'wc-ales');
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, status, author_agent_id, author_name, created_at) VALUES (?, 'wave', 'wc-ales', 'open', ?, 'ales', '2026-10-01 00:00:00')`,
    ).run(oldSha, ales.id);

    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'main-only');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main feature');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', 'merge main', 'origin/main');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', git(repo, 'rev-parse', 'HEAD'));

    const pings = () => db.getDb().prepare('SELECT entity_id FROM events WHERE type = ?').all(MAIN_PING) as { entity_id: string }[];
    const status = () => (db.getDb().prepare('SELECT status FROM release_freezes WHERE sha = ?').get(oldSha) as { status: string }).status;
    (await reconcileBehindFreezes());
    expect(status()).toBe('open');
    expect(pings()).toEqual([]);

    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', oldSha);
    let now = 1_700_000_000_000;
    setLaneAlertNowForTest(() => now);
    (await reconcileBehindFreezes());
    expect(status()).toBe('behind-main');
    expect(pings()).toHaveLength(1);

    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm2.txt'), 'later');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved again');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    (await reconcileBehindFreezes());
    expect(pings()).toHaveLength(1);

    now += 30 * 60 * 1000;
    (await reconcileBehindFreezes());
    expect(pings()).toHaveLength(2);
  });
});

describe('lane retire: nothing main lacks', () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lane-retire-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    resetLaneRetireMemoForTest();
    projects.wave = { repo, workspace_match: '**/*', lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane work');
    db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-ales', workspace: repo, mode: 'spawned', status: 'idle' });
  });

  afterEach(() => {
    setLaneAlertNowForTest(null);
    resetLaneRetireMemoForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
  });

  /** main merges the lane (PR merge), then moves on; the lane merges main back so its tip is not an ancestor of main. */
  function mergeLaneIntoMainThenSyncLane(): { mainSha: string; laneTip: string } {
    git(repo, 'checkout', '-q', 'main');
    git(repo, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', 'Merge PR #115 wc-ales', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'main moved on');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved on');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', 'merge main', 'origin/main');
    const laneTip = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', laneTip);
    return { mainSha, laneTip };
  }

  it('answers from git cherry: empty once the lane is merged, not before', async () => {
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'main'));
    expect((await laneHasNothingMainLacks(repo, 'origin/main', git(repo, 'rev-parse', 'wc-ales')))).toBe(false);
    const { laneTip } = mergeLaneIntoMainThenSyncLane();
    // The lane tip is a merge of main, so it is not an ancestor of main: ancestry alone would never close it.
    expect(() => git(repo, 'merge-base', '--is-ancestor', laneTip, 'origin/main')).toThrow();
    expect((await laneHasNothingMainLacks(repo, 'origin/main', laneTip))).toBe(true);
  });

  it('retires a merged lane instead of pinging it: freezes closed as merged, one lane.retired event, no main_ping', async () => {
    const laneBefore = git(repo, 'rev-parse', 'wc-ales');
    db.getDb().prepare(`INSERT INTO release_freezes (sha, project, lane, verdict, status) VALUES (?, 'wave', 'wc-ales', 'pass', 'behind-main')`).run(laneBefore);
    const { mainSha, laneTip } = mergeLaneIntoMainThenSyncLane();
    db.getDb().prepare(`INSERT INTO release_freezes (sha, project, lane, verdict, status) VALUES (?, 'wave', 'wc-ales', 'pass', 'open')`).run(laneTip);
    expect((await pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha, kind: 'moved' }))).toBe(false);
    const pings = db.getDb().prepare('SELECT 1 FROM events WHERE type = ?').all(MAIN_PING);
    expect(pings).toHaveLength(0);
    const retired = db.getDb().prepare('SELECT entity_id, payload_json FROM events WHERE type = ?').all(LANE_RETIRED) as { entity_id: string; payload_json: string }[];
    expect(retired).toHaveLength(1);
    expect(retired[0].entity_id).toBe(`wc-ales@${laneTip.slice(0, 8)}`);
    expect(JSON.parse(retired[0].payload_json).freezes_closed).toBe(2);
    const statuses = db.getDb().prepare("SELECT status, superseded_by FROM release_freezes WHERE lane = 'wc-ales'").all() as { status: string; superseded_by: string | null }[];
    expect(statuses.every((s) => s.status === 'merged' && s.superseded_by === 'main')).toBe(true);
    // The branch is still there.
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/wc-ales')).toBe(laneTip);
    // A second pass is quiet: no second event, still no ping.
    expect((await pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha, kind: 'freeze' }))).toBe(false);
    expect(db.getDb().prepare('SELECT 1 FROM events WHERE type = ?').all(LANE_RETIRED)).toHaveLength(1);
    expect(db.listAgentMessages({ limit: 10 }).some((m) => m.message.includes('behind main'))).toBe(false);
  });

  it('keeps pinging a lane that still has a commit main lacks', async () => {
    const { mainSha } = mergeLaneIntoMainThenSyncLane();
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'more');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'more lane work');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', git(repo, 'rev-parse', 'HEAD'));
    // main moves again so the lane is behind.
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'n.txt'), 'again');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main again');
    const main2 = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', main2);
    expect(main2).not.toBe(mainSha);
    expect((await pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha: main2, kind: 'moved' }))).toBe(true);
    expect(db.getDb().prepare('SELECT 1 FROM events WHERE type = ?').all(LANE_RETIRED)).toHaveLength(0);
  });

  it('reconcileBehindFreezes retires rather than marks behind-main', async () => {
    const { laneTip } = mergeLaneIntoMainThenSyncLane();
    // main moves once more so the lane tip no longer contains main.
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'n.txt'), 'again');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main again');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    db.getDb().prepare(`INSERT INTO release_freezes (sha, project, lane, verdict, status) VALUES (?, 'wave', 'wc-ales', 'pass', 'open')`).run(laneTip);
    await reconcileBehindFreezes();
    const row = db.getDb().prepare('SELECT status FROM release_freezes WHERE sha = ?').get(laneTip) as { status: string };
    expect(row.status).toBe('merged');
    expect(db.getDb().prepare('SELECT 1 FROM events WHERE type = ?').all(MAIN_PING)).toHaveLength(0);
    expect(db.getDb().prepare('SELECT 1 FROM events WHERE type = ?').all(LANE_RETIRED)).toHaveLength(1);
  });
});
