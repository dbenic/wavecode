import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakePeer } from './peers.test-helpers.js';

vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./task-dispatcher.js', () => ({
  dispatchNext: vi.fn(),
  unblockDependentsPublic: vi.fn(),
  onRunComplete: vi.fn(),
  finalizeRun: vi.fn(),
}));

const artifactsConfig = { storage: '', retention_days: 30 };
const reviewConfig: Record<string, unknown> = {
  auto_review: false,
  default_reviewer: 'aider',
  self_review: true,
  max_fix_loops: 2,
  require_pass_to_promote: false,
  gate_dependents_on_approval: false,
  auto_pick: true,
  freeze_inbox: [] as string[],
};
const projectsConfig: Record<string, { workspace_match: string; release_peer?: string; repo?: string; candidate_refs?: string }> = {};
const peersConfig: Record<string, { url: string; token: string; agents?: string[] }> = {};

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ review: reviewConfig, projects: projectsConfig, peers: peersConfig, paths: {}, artifacts: artifactsConfig })),
}));

import { emit } from './event-bus.js';

const SHA_A = '2431f684b9e960b84e73a4e98b5068869664ffb4';
const SHA_B = 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_C = '3562f0404cfc19de7ea6946ec57aa381055f8479';

const DESK91_FREEZE = `# Desk #91 freeze note — issued credit notes (review PASS)

Project: wavepulse (Countix) · Task: Desk #91 freeze for release · Author: claude2 · Date: 2026-10-09

## Candidate
- **Lane:** \`wc-claude2\` (pushed)
- **Freeze SHA:** \`${SHA_A}\`
- **Base:** \`origin/main\` \`3b277571\` (up to date)
- **Review:** @codex3 **VERDICT: PASS** on this exact SHA: \`/home/wave/.wavecode-data/rooms/wavepulse/REPORTS/2026-10-09-desk91-${SHA_A.slice(0, 8)}-code-review-codex3.md\`
- **Review history:** fe423261 NEEDS FIXES (R1–R5) → 47c9dd0a → e65a2ab5 NEEDS FIXES (F1) → 2431f684 PASS.

## Preflight on the exact SHA
- Remote full-tuned: GREEN
`;

const VERDICT_PASS = `# Verdict: Claude2 Desk #91 issued credit notes (exact SHA ${SHA_A})
Countix / wavepulse · review of /home/wave/inbox/desk91-freeze-${SHA_A.slice(0, 8)}.md · reviewer Codex3 · 2026-10-09

## Checked
- Lint and tests on the exact SHA: 212/212 pass.

VERDICT: PASS
`;

const VERDICT_NEEDS_FIXES = `# Verdict: Codex2 SI AOP retained earnings by sign (exact SHA ${SHA_C})
Countix / wavepulse · review of /home/wave/inbox/codex2-freeze-si-aop-retained-${SHA_C.slice(0, 8)}-20261009.md · reviewer Claude1 · 2026-10-09

## B1 (blocking): the legacy rule depends on account presence, not balance
- [HIGH] usesSplitRetainedAccounts must test the balance.

VERDICT: NEEDS FIXES
`;

const FREEZE_REQUEST_ONLY = `# Codex2 freeze — SI AOP retained earnings by sign

WavePulse, SI AOP 0.442.9 correction, Codex2, 2026-10-09. Independent reviewer: Claude1.

## Frozen candidate

- Exact SHA: \`${SHA_C}\`
- Base: \`3b277571260d7d6c45a87937175c8b372408524c\` (\`origin/main\`, release 0.442.9)
- Branch: \`wc-codex2-wavenetic-04420-composition\`

Please review the exact SHA and issue \`VERDICT: PASS\` or \`VERDICT: NEEDS FIXES\` on the exact SHA.

VERDICT requested: \`PASS\` or \`NEEDS FIXES\`.
`;

describe('release-freezes.ts', () => {
  let tmp: string;
  let inbox: string;
  let db: typeof import('./db.js');
  let rf: typeof import('./release-freezes.js');
  let rq: typeof import('./review-queue.js');
  let peers: typeof import('./peers.js');

  const write = (name: string, text: string, mtimeMs?: number): string => {
    const file = path.join(inbox, name);
    fs.writeFileSync(file, text);
    if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  };
  const agent = (name: string, runtime = 'codex') => {
    const r = db.insertAgent({ name, runtime, tmux_session: `wc-${name}`, workspace: path.join(tmp, 'ws', name), mode: 'spawned', status: 'idle' });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const reviewRows = (runId: string) => db.getDb().prepare('SELECT * FROM code_reviews WHERE run_id = ?').all(runId) as Array<{ verdict: string }>;

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(emit).mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-freezes-'));
    inbox = path.join(tmp, 'inbox');
    fs.mkdirSync(inbox);
    reviewConfig.freeze_inbox = [inbox];
    artifactsConfig.storage = path.join(tmp, 'store');
    reviewConfig.require_pass_to_promote = false;
    for (const k of Object.keys(projectsConfig)) delete projectsConfig[k];
    for (const k of Object.keys(peersConfig)) delete peersConfig[k];
    projectsConfig.wavepulse = { workspace_match: '**/ws/*' };
    db = await import('./db.js');
    db.initDb(path.join(tmp, 't.db'));
    rf = await import('./release-freezes.js');
    rq = await import('./review-queue.js');
    peers = await import('./peers.js');
    const codeReview = await import('./code-review.js');
    codeReview.ensureReviewTable();
    peers.ensurePeerTables();
    rf.ensureReleaseFreezeTable();
    rf.resetFreezesForTest();
    agent('claude2', 'claude-code');
    agent('codex3');
    agent('codex2');
    agent('claude1', 'claude-code');
  });

  afterEach(() => {
    rf.resetFreezesForTest();
    peers.stopPeerPollers();
    peers.setPeerFetchForTest(null);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('parseFreezeFile', () => {
    it('reads a freeze note: exact SHA, lane, author, desk, inline reviewer PASS with the verdict path, gate', () => {
      const p = rf.parseFreezeFile(DESK91_FREEZE, `desk91-freeze-${SHA_A.slice(0, 8)}.md`);
      expect(p).toMatchObject({ kind: 'freeze', sha: SHA_A, verdict: 'pass', desk: 91, lane: 'wc-claude2', project: 'wavepulse', gate: 'GREEN' });
      expect(p!.authorCandidates[0]).toBe('claude2');
      expect(p!.reviewerCandidates[0]).toBe('codex3');
      expect(p!.verdictPath).toContain('/REPORTS/2026-10-09-desk91-');
    });

    it('reads a verdict file: SHA from the title, reviewer from the file name, author from the reviewed freeze path', () => {
      const p = rf.parseFreezeFile(VERDICT_NEEDS_FIXES, `claude1-verdict-codex2-si-aop-retained-${SHA_C.slice(0, 8)}-20261009.md`);
      expect(p).toMatchObject({ kind: 'verdict', sha: SHA_C, verdict: 'needs-fixes' });
      expect(p!.reviewerCandidates[0]).toBe('claude1');
      expect(p!.authorCandidates).toContain('codex2');
    });

    it('a freeze note that only REQUESTS a verdict has none (base SHA is not the candidate)', () => {
      const p = rf.parseFreezeFile(FREEZE_REQUEST_ONLY, `codex2-freeze-si-aop-retained-${SHA_C.slice(0, 8)}-20261009.md`);
      expect(p).toMatchObject({ kind: 'freeze', sha: SHA_C, verdict: null, lane: 'wc-codex2-wavenetic-04420-composition' });
      expect(p!.authorCandidates).toContain('codex2');
      expect(p!.reviewerCandidates[0]).toBe('claude1');
    });

    it('"Project: Countix" (the company) maps to the configured project mentioned in the text', () => {
      const text = VERDICT_PASS.replace('Countix / wavepulse', 'Project: Countix · WavePulse 0.442.9');
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, text);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.project).toBe('wavepulse');
    });

    it('ignores files that are neither', () => {
      expect(rf.parseFreezeFile('# Proposal\n\nsome text', 'proposal-testing-host.md')).toBeNull();
    });
  });

  describe('ingest', () => {
    it('a PASS verdict file creates a Review-queue card with Promote (an independent PASS on the exact SHA)', () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      const r = rf.ingestFreezeFile(file);
      expect(r.ok && r.data.effect).toBe('card');
      const items = rq.listPendingReviews();
      expect(items).toHaveLength(1);
      expect(items[0].freeze).toMatchObject({ sha: SHA_A, verdict: 'pass', reviewer_name: 'codex3', author_name: 'claude2', project: 'wavepulse', desk: 91, verdict_path: file, status: 'open' });
      expect(items[0].latestReview?.verdict).toBe('pass');
      expect(items[0].agentName).toBe('claude2');
      expect(items[0].task.prompt).toMatch(/Release freeze wavepulse Desk #91 @ 2431f684/);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.ai_completed', 'run', items[0].run.id,
        expect.objectContaining({ verdict: 'pass', reviewer_agent: 'codex3', freeze: expect.objectContaining({ sha: SHA_A }) }), null);
    });

    it('every ingested freeze note or verdict is archived as a library document, linked from the event', () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      const docs = db.listArtifacts({ kind: 'document' });
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ filename: path.basename(file), desk: '91', room: 'wavepulse' });
      expect(docs[0].provenance).toContain(`verdict on exact SHA ${SHA_A}`);
      expect(docs[0].provenance).toContain('reviewer @codex3');
      expect(docs[0].note).toMatch(/^Verdict: Claude2 Desk #91/);
      expect(fs.readFileSync(docs[0].storage_path, 'utf-8')).toBe(VERDICT_PASS);
      const call = vi.mocked(emit).mock.calls.find((c) => c[0] === 'review.ai_completed');
      expect((call?.[3] as { freeze: { archive: string } }).freeze.archive).toBe(docs[0].storage_path);
      // the same file again: still one document
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      expect(db.listArtifacts({ kind: 'document' })).toHaveLength(1);
    });

    it('a freeze note carrying the reviewer PASS inline (Desk #91) creates the card and links both files', () => {
      const file = write(`desk91-freeze-${SHA_A.slice(0, 8)}.md`, DESK91_FREEZE);
      const r = rf.ingestFreezeFile(file);
      expect(r.ok && r.data.effect).toBe('card');
      const [item] = rq.listPendingReviews();
      expect(item.freeze).toMatchObject({ sha: SHA_A, verdict: 'pass', reviewer_name: 'codex3', author_name: 'claude2', lane: 'wc-claude2', gate: 'GREEN', freeze_path: file });
      expect(item.freeze!.verdict_path).toContain('code-review-codex3.md');
    });

    it('NEEDS FIXES creates a card without Promote: the server refuses to promote it', () => {
      const file = write(`claude1-verdict-codex2-si-aop-${SHA_C.slice(0, 8)}-20261009.md`, VERDICT_NEEDS_FIXES);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      expect(item.freeze).toMatchObject({ sha: SHA_C, verdict: 'needs-fixes', reviewer_name: 'claude1', author_name: 'codex2' });
      const promoted = rq.promote(item.run.id);
      expect(promoted.ok).toBe(false);
      expect(!promoted.ok && promoted.error).toMatch(/Promotion blocked: verdict is 'needs-fixes'/);
      expect(vi.mocked(emit).mock.calls.some((c) => c[0] === 'review.promoted')).toBe(false);
    });

    it('a self-review is refused: no card when the reviewer is the author', () => {
      const text = VERDICT_PASS.replace('reviewer Codex3', 'reviewer Claude2');
      const file = write(`claude2-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, text);
      const r = rf.ingestFreezeFile(file);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/self-review refused/);
      expect(rq.listPendingReviews()).toHaveLength(0);
      expect(rf.getFreeze(SHA_A)).toBeNull();
    });

    it('a freeze note without a verdict is stored, and the later verdict file completes the card with both links', () => {
      const note = write(`codex2-freeze-si-aop-retained-${SHA_C.slice(0, 8)}-20261009.md`, FREEZE_REQUEST_ONLY);
      const stored = rf.ingestFreezeFile(note);
      expect(stored.ok && stored.data.effect).toBe('stored');
      expect(rq.listPendingReviews()).toHaveLength(0);
      const verdict = write(`claude1-verdict-codex2-si-aop-retained-${SHA_C.slice(0, 8)}-20261009.md`, VERDICT_NEEDS_FIXES.replace('VERDICT: NEEDS FIXES', 'VERDICT: PASS'));
      const r = rf.ingestFreezeFile(verdict);
      expect(r.ok && r.data.effect).toBe('card');
      const [item] = rq.listPendingReviews();
      expect(item.freeze).toMatchObject({ sha: SHA_C, verdict: 'pass', freeze_path: note, verdict_path: verdict, lane: 'wc-codex2-wavenetic-04420-composition', author_name: 'codex2', reviewer_name: 'claude1' });
    });

    it('a re-delivered file is idempotent: one card, one review row, no second event', () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      const again = rf.ingestFreezeFile(file);
      expect(again.ok && again.data.effect).toBe('noop');
      const items = rq.listPendingReviews();
      expect(items).toHaveLength(1);
      expect(reviewRows(items[0].run.id)).toHaveLength(1);
      expect(vi.mocked(emit).mock.calls.filter((c) => c[0] === 'review.ai_completed')).toHaveLength(1);
    });

    it('a changed verdict on the same SHA (second reviewer, or a re-review) adds a review row, same card', () => {
      write(`claude1-verdict-x-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES);
      expect(rf.ingestFreezeFile(path.join(inbox, `claude1-verdict-x-${SHA_C.slice(0, 8)}.md`)).ok).toBe(true);
      const file = write(`claude1-verdict-x-r2-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES.replace('VERDICT: NEEDS FIXES', 'VERDICT: PASS'));
      const r = rf.ingestFreezeFile(file);
      expect(r.ok && r.data.effect).toBe('updated');
      const items = rq.listPendingReviews();
      expect(items).toHaveLength(1);
      expect(items[0].freeze?.verdict).toBe('pass');
      expect(items[0].latestReview?.verdict).toBe('pass');
      expect(reviewRows(items[0].run.id)).toHaveLength(2);
    });
  });

  describe('rules', () => {
    it('a newer commit on the same lane invalidates the older PASS: stale SHA is refused, even with an override reason', () => {
      const old = write(`desk91-freeze-${SHA_B.slice(0, 8)}.md`, DESK91_FREEZE.replaceAll(SHA_A, SHA_B));
      expect(rf.ingestFreezeFile(old).ok).toBe(true);
      const [oldItem] = rq.listPendingReviews();
      const newer = write(`desk91-freeze-${SHA_A.slice(0, 8)}.md`, DESK91_FREEZE);
      expect(rf.ingestFreezeFile(newer).ok).toBe(true);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'stale', superseded_by: SHA_A });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.superseded', 'run', oldItem.run.id, expect.objectContaining({ sha: SHA_B, superseded_by: SHA_A }), null);
      const r = rq.promote(oldItem.run.id, { overrideReason: 'ship it anyway' });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/stale/);
      const items = rq.listPendingReviews();
      expect(items.map((i) => i.freeze?.status).sort()).toEqual(['open', 'stale']);
    });

    it('a verdict-only row (no lane line) is superseded by a newer freeze for the same desk', () => {
      // claude2's verdict file for Desk #108 carries no Lane: line → lane null
      const v = write(`claude2-verdict-pd108-s1-${SHA_B.slice(0, 8)}.md`, `# Verdict: Codex2 PD-108 S1 (exact SHA ${SHA_B})\nProject: wavepulse · reviewer Claude2 · Author: codex2\n\n- [HIGH] renumber the migrations\n\nVERDICT: NEEDS FIXES\n`);
      expect(rf.ingestFreezeFile(v).ok).toBe(true);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'open', lane: null, desk: 108, verdict: 'needs-fixes' });
      // codex2's newer freeze for Desk #108 on its lane
      const note = write(`codex2-pd108-s1-freeze-${SHA_A.slice(0, 8)}.md`, `# Codex2 freeze — PD-108 S1 r2\n\nProject: wavepulse · Author: codex2 · Desk #108\n- Branch: \`wc-codex2-pd108\`\n- Exact SHA: \`${SHA_A}\`\n\nIndependent reviewer: Claude2.\n`);
      expect(rf.ingestFreezeFile(note).ok).toBe(true);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'stale', superseded_by: SHA_A });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.superseded', 'run', expect.any(String), expect.objectContaining({ sha: SHA_B, superseded_by: SHA_A, by: 'desk' }), null);
    });

    it('reconcile marks older open freezes per desk stale even when the newer one was ingested before the rule', () => {
      const old = write(`claude2-verdict-pd108-${SHA_B.slice(0, 8)}.md`, `# Verdict: Codex2 PD-108 (exact SHA ${SHA_B})\nProject: wavepulse · reviewer Claude2 · Author: codex2\n\nVERDICT: NEEDS FIXES\n`);
      expect(rf.ingestFreezeFile(old).ok).toBe(true);
      const newer = write(`codex2-pd108-freeze-${SHA_A.slice(0, 8)}.md`, `# Codex2 freeze PD-108 r2\nProject: wavepulse · Author: codex2 · Desk #108\n- Exact SHA: \`${SHA_A}\`\n`);
      expect(rf.ingestFreezeFile(newer).ok).toBe(true);
      // simulate rows that predate the rule: reopen the old one
      db.getDb().prepare("UPDATE release_freezes SET status = 'open', superseded_by = NULL WHERE sha = ?").run(SHA_B);
      expect(rf.getFreeze(SHA_B)!.status).toBe('open');
      expect(rf.reconcileSuperseded()).toBe(1);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'stale', superseded_by: SHA_A });
      expect(rf.getFreeze(SHA_A)!.status).toBe('open');
      expect(rf.reconcileSuperseded()).toBe(0);
    });

    it('a SHA inside an unreleased candidate branch is "in candidate"; a released candidate (on main) no longer counts', () => {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const repo = path.join(tmp, 'repo-rc');
      fs.mkdirSync(repo);
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env }).trim();
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git('add', '.'); git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'lane'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); git('add', '.'); git('commit', '-q', '-m', 'lane work');
      const laneSha = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'rc'); fs.writeFileSync(path.join(repo, 'c.txt'), 'c'); git('add', '.'); git('commit', '-q', '-m', 'compose');
      const rcSha = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      // remote-tracking refs as a fetch would leave them
      git('update-ref', 'refs/remotes/origin/main', base);
      git('update-ref', 'refs/remotes/origin/fable/rc-0443-2', rcSha);
      git('update-ref', 'refs/remotes/origin/fable/rc-0443-1', base); // released: equals main
      projectsConfig.wavepulse.repo = repo;
      projectsConfig.wavepulse.candidate_refs = 'fable/rc-*';
      rf.resetMergedCacheForTest();
      rf.setFetchDisabledForTest(true);
      expect(rf.candidateFor('wavepulse', laneSha)).toEqual({ ref: 'origin/fable/rc-0443-2', name: 'fable/rc-0443-2' });
      expect(rf.candidateFor('wavepulse', base)).toBeNull(); // on main already (released candidate ignored)
      expect(rf.isOnMain('wavepulse', laneSha)).toBe(false);
      rf.setFetchDisabledForTest(false);
      delete projectsConfig.wavepulse.repo;
      delete projectsConfig.wavepulse.candidate_refs;
    });

    it('a SHA that is already on the project main is closed as merged, its queue card approved', () => {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo);
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
      git('add', '.'); git('commit', '-q', '-m', 'first');
      const merged = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'wc-x');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
      git('add', '.'); git('commit', '-q', '-m', 'lane');
      const unmerged = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      projectsConfig.wavepulse.repo = repo;
      rf.resetMergedCacheForTest();

      for (const [sha, name] of [[merged, 'merged'], [unmerged, 'open']] as const) {
        const f = write(`desk91-freeze-${name}.md`, DESK91_FREEZE.replaceAll(SHA_A, sha).replace('wc-claude2', `wc-${name}`).replace('Desk #91', `Desk #9${name.length}`));
        expect(rf.ingestFreezeFile(f).ok).toBe(true);
      }
      expect(rf.isOnMain('wavepulse', merged)).toBe(true);
      expect(rf.isOnMain('wavepulse', unmerged)).toBe(false);
      expect(rf.isOnMain('wavepulse', 'f'.repeat(40))).toBeNull();
      expect(rf.reconcileMerged()).toBe(1);
      expect(rf.getFreeze(merged)).toMatchObject({ status: 'merged', superseded_by: 'main' });
      expect(rf.getFreeze(unmerged)).toMatchObject({ status: 'open' });
      const cards = rq.listPendingReviews();
      expect(cards.map((c) => c.freeze?.sha)).toEqual([unmerged]);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.superseded', 'run', expect.any(String), expect.objectContaining({ sha: merged, superseded_by: 'main', by: 'merged' }), null);
      delete projectsConfig.wavepulse.repo;
    });

    it('retry and hand-off do not apply to a freeze card', () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      expect(rq.retry(item.run.id).ok).toBe(false);
      expect(rq.handOff(item.run.id, 'codex2').ok).toBe(false);
    });
  });

  describe('promote and reject', () => {
    it('Promote emits review.promoted with the freeze and sends the production GO to the deploy box as a release record', async () => {
      peersConfig.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      projectsConfig.wavepulse.release_peer = 'deploy/fable';
      const fp = fakePeer();
      peers.setPeerFetchForTest(fp.fetchImpl);
      const file = write(`desk91-freeze-${SHA_A.slice(0, 8)}.md`, DESK91_FREEZE);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      const [item] = rq.listPendingReviews();

      const r = rq.promote(item.run.id);
      expect(r.ok).toBe(true);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.promoted', 'run', item.run.id,
        expect.objectContaining({ verdict: 'pass', override_reason: null, freeze: expect.objectContaining({ sha: SHA_A, reviewer: 'codex3', author: 'claude2', desk: 91 }) }));
      for (let i = 0; i < 40 && fp.state.releases.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
      expect(fp.state.releases).toHaveLength(1);
      expect(fp.state.releases[0]).toMatchObject({ target: 'production', sha: SHA_A, lane: 'wc-claude2', project: 'wavepulse', desk: '91', reviewer: 'codex3' });
      // the GO is a record, never a line typed into a pane
      expect(fp.state.sends).toHaveLength(0);
      const releases = await import('./releases.js');
      for (let i = 0; i < 40 && releases.listReleases({ sha: SHA_A })[0]?.status !== 'sent'; i++) await new Promise((res) => setTimeout(res, 10));
      expect(releases.listReleases({ sha: SHA_A })[0]).toMatchObject({ target: 'production', status: 'sent', run_id: item.run.id, peer: 'deploy' });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.requested', 'release', expect.any(String), expect.objectContaining({ target: 'production', sha: SHA_A, peer: 'deploy' }));
      expect(rf.getFreeze(SHA_A)).toMatchObject({ status: 'promoted' });
      expect(rq.listPendingReviews()).toHaveLength(0);
      releases.stopReleasePollers();
    });

    it('Promote never bypasses the rules through require_pass_to_promote=false', () => {
      reviewConfig.require_pass_to_promote = false;
      const file = write(`claude1-verdict-codex2-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      expect(rq.promote(item.run.id).ok).toBe(false);
      // an admin override with a stored reason still works for a non-PASS (the route checks the role)
      const r = rq.promote(item.run.id, { overrideReason: 'hotfix agreed with Denis' });
      expect(r.ok).toBe(true);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.promoted', 'run', item.run.id, expect.objectContaining({ override_reason: 'hotfix agreed with Denis' }));
    });

    it('Reject removes the card with a reason, and a re-delivered file does not revive it', () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect(rf.ingestFreezeFile(file).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      const r = rq.reject(item.run.id, { reason: 'wrong base, refreeze on main' });
      expect(r.ok).toBe(true);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.rejected', 'run', item.run.id, expect.objectContaining({ reason: 'wrong base, refreeze on main', freeze: expect.objectContaining({ sha: SHA_A }) }));
      expect(rf.getFreeze(SHA_A)).toMatchObject({ status: 'rejected', decision_reason: 'wrong base, refreeze on main' });
      expect(rq.listPendingReviews()).toHaveLength(0);
      const again = rf.ingestFreezeFile(file);
      expect(again.ok && again.data.effect).toBe('noop');
      expect(rq.listPendingReviews()).toHaveLength(0);
    });
  });

  describe('inbox watcher and backfill', () => {
    it('backfill imports today\'s PASS verdicts and freezes only: yesterday\'s files and NEEDS FIXES stay out', () => {
      const yesterday = Date.now() - 36 * 3600 * 1000;
      write(`desk91-freeze-${SHA_B.slice(0, 8)}.md`, DESK91_FREEZE.replaceAll(SHA_A, SHA_B).replace('wc-claude2', 'wc-old-lane'), yesterday);
      write(`claude1-verdict-codex2-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES);
      write(`desk91-freeze-${SHA_A.slice(0, 8)}.md`, DESK91_FREEZE);
      write('notes.md', 'unrelated');
      rf.backfillFreezes();
      const items = rq.listPendingReviews();
      expect(items.map((i) => i.freeze?.sha)).toEqual([SHA_A]);
      expect(rf.getFreeze(SHA_B)).toBeNull();
      expect(rf.getFreeze(SHA_C)).not.toBeNull(); // known, but no card until a PASS or a live delivery
    });

    it('a file event on the watched inbox ingests the file once it settled; a repeat event on an unchanged file is a no-op', async () => {
      const name = `codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`;
      write(name, VERDICT_PASS);
      rf.onInboxEvent(inbox, name, 10);
      rf.onInboxEvent(inbox, 'notes.md', 10);         // not a freeze/verdict file
      rf.onInboxEvent(inbox, '.swp-' + name, 10);     // editor temp file
      await new Promise((res) => setTimeout(res, 60));
      const items = rq.listPendingReviews();
      expect(items).toHaveLength(1);
      expect(items[0].freeze?.sha).toBe(SHA_A);
      rf.onInboxEvent(inbox, name, 10);               // fs.watch fires several events per write
      await new Promise((res) => setTimeout(res, 60));
      expect(reviewRows(items[0].run.id)).toHaveLength(1);
    });

    it('startFreezeWatchers watches the configured inbox and stops cleanly', () => {
      rf.startFreezeWatchers();
      rf.stopFreezeWatchers();
      reviewConfig.freeze_inbox = [path.join(tmp, 'missing')];
      rf.startFreezeWatchers(); // missing dir: warns, no throw
    });
  });
});
