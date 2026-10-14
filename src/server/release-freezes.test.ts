import { execFileSync } from 'node:child_process';
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

  afterEach(async () => {
    await rf.pendingInboxForTest();
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

    it('"Project: Countix" (the company) maps to the configured project mentioned in the text', async () => {
      const text = VERDICT_PASS.replace('Countix / wavepulse', 'Project: Countix · WavePulse 0.442.9');
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, text);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.project).toBe('wavepulse');
    });

    it('ignores files that are neither', () => {
      expect(rf.parseFreezeFile('# Proposal\n\nsome text', 'proposal-testing-host.md')).toBeNull();
    });

    it('does not treat is, from, remains or update as a lane name', () => {
      const quoted = `# Desk #7 freeze note\n\nProject: wavepulse\n- The lane is \`wc-claude2\`\n- Freeze SHA: \`${SHA_A}\`\n`;
      expect(rf.parseFreezeFile(quoted, 'desk7-freeze.md')?.lane).toBe('wc-claude2');
      const from = `# Freeze note\n\n- Branch from \`wc-codex2\`\n- Exact SHA: \`${SHA_A}\`\n`;
      expect(rf.parseFreezeFile(from, 'freeze.md')?.lane).toBe('wc-codex2');
      const bare = `# Freeze note\n\nLane is wc-claude2\n- Exact SHA: \`${SHA_A}\`\n`;
      expect(rf.parseFreezeFile(bare, 'freeze.md')?.lane).toBe('wc-claude2');
      const junk = `# Freeze note\n\nThe lane remains update from the last push.\n- Exact SHA: \`${SHA_A}\`\n`;
      expect(rf.parseFreezeFile(junk, 'freeze.md')?.lane).toBeNull();
      expect(rf.isFillerLane('remains')).toBe(true);
      expect(rf.isFillerLane('wc-claude2')).toBe(false);
      for (const word of ['changes', 'source', 'separately', 'held', 'also', 'commits', 'test-path']) {
        const named = `# Freeze note\n\nLane: \`${word}\`\n- Exact SHA: \`${SHA_A}\`\n`;
        expect(rf.parseFreezeFile(named, 'freeze.md')?.lane).toBeNull();
        expect(rf.isFillerLane(word)).toBe(true);
      }
      const prose = `# Freeze note\n\nThe changes were reviewed with wc-ales-claude1, held separately.\n- Exact SHA: \`${SHA_A}\`\n`;
      expect(rf.parseFreezeFile(prose, 'freeze.md')?.lane).toBeNull();
    });

    it('a composition release is not labelled with one desk number', () => {
      const note = `# Composition release — wavepulse 0.442.0\n\nProject: wavepulse · Author: codex2\n- Lane: \`wc-codex2-wavenetic-04420-composition\`\n- Freeze SHA: \`${SHA_C}\`\n\nBundles Desk #91 with the SI AOP work.\n`;
      const p = rf.parseFreezeFile(note, `composition-freeze-${SHA_C.slice(0, 8)}.md`);
      expect(p?.lane).toBe('wc-codex2-wavenetic-04420-composition');
      expect(p?.desk).toBeNull();
      expect(rf.freezeNoteSummary(p?.title ?? '')).toBe('wavepulse 0.442.0');
    });

    it('two desk numbers are not collapsed into one', () => {
      const note = `# Freeze note — paired desks\n\nProject: wavepulse\nDesk #91 and Desk #108\n- Lane: \`wc-claude2\`\n- Exact SHA: \`${SHA_A}\`\n`;
      const p = rf.parseFreezeFile(note, 'freeze.md');
      expect(p?.desk).toBeNull();
      expect(p?.lane).toBe('wc-claude2');
      expect(rf.freezeNoteSummary(p?.title ?? '')).toBe('paired desks');
    });
  });

  describe('ingest', () => {
    it('a PASS verdict file creates a Review-queue card with Promote (an independent PASS on the exact SHA)', async () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      const r = (await rf.ingestFreezeFile(file));
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

    it('every ingested freeze note or verdict is archived as a library document, linked from the event', async () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
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
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(db.listArtifacts({ kind: 'document' })).toHaveLength(1);
    });

    it('re-ingesting a freeze note recomputes the gate and clears a stale GREEN', async () => {
      const green = `# Desk #7 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`wc-claude2\`\n- Freeze SHA: \`${SHA_A}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\nRESULT GREEN\n`;
      const file = write(`desk7-freeze-${SHA_A.slice(0, 8)}.md`, green);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.gate).toBe('GREEN');

      fs.writeFileSync(file, green.replace('RESULT GREEN', `RESULT GREEN sha=${SHA_B} ${SHA_A.slice(0, 8)}`));
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.gate).toBeNull();
      expect((await rf.viewShaChecks(rf.getFreeze(SHA_A)!)).gate).toBeNull();

      fs.writeFileSync(file, green);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.gate).toBe('GREEN');

      fs.writeFileSync(file, green.replace('RESULT GREEN\n', ''));
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      const cleared = rf.getFreeze(SHA_A);
      expect(cleared?.gate).toBeNull();
      expect((await rf.viewShaChecks(cleared!)).gate).toBeNull();
      expect((await rf.viewShaChecks(cleared!)).full).not.toBe('green');
    });

    it('a retracted note GREEN follows the latest command word, and only a GREEN command stays green', async () => {
      const green = `# Desk #7 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`wc-claude2\`\n- Freeze SHA: \`${SHA_A}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\nRESULT GREEN\n`;
      const file = write(`desk7-events-${SHA_A.slice(0, 8)}.md`, green);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.gate).toBe('GREEN');
      const retracted = green.replace('RESULT GREEN\n', '');
      const event = (gate: string) => {
        const saved = db.insertEvent({
          type: 'pipeline.gate', entity_type: 'run', entity_id: `${SHA_A}:full`, payload: { sha: SHA_A, gate },
        });
        expect(saved.ok).toBe(true);
      };
      fs.writeFileSync(file, retracted);
      event('QUEUED');
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.gate).toBe('QUEUED');
      expect((await rf.viewShaChecks(rf.getFreeze(SHA_A)!)).full).not.toBe('green');

      event('RED');
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.gate).toBe('RED');
      expect((await rf.viewShaChecks(rf.getFreeze(SHA_A)!)).full).not.toBe('green');

      event('GREEN');
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      expect(rf.getFreeze(SHA_A)?.gate).toBe('GREEN');
      expect((await rf.viewShaChecks(rf.getFreeze(SHA_A)!)).full).toBe('green');
    });

    it('a freeze note carrying the reviewer PASS inline (Desk #91) creates the card and links both files', async () => {
      const file = write(`desk91-freeze-${SHA_A.slice(0, 8)}.md`, DESK91_FREEZE);
      const r = (await rf.ingestFreezeFile(file));
      expect(r.ok && r.data.effect).toBe('card');
      const [item] = rq.listPendingReviews();
      expect(item.freeze).toMatchObject({ sha: SHA_A, verdict: 'pass', reviewer_name: 'codex3', author_name: 'claude2', lane: 'wc-claude2', gate: 'GREEN', freeze_path: file });
      expect(item.freeze!.verdict_path).toContain('code-review-codex3.md');
    });

    it('a verdict file stores R#/P# findings as issues and keeps the needs-fixes verdict', async () => {
      const text = `# Verdict: Codex2 Desk (exact SHA ${SHA_C})\nProject: wavepulse · reviewer Claude1 · Author: codex2\n\nR1 — P1 the balance check ignores sign\nR2 (P2) rounding on the credit note\n\nVERDICT: NEEDS FIXES\n`;
      expect((await rf.ingestFreezeFile(write(`claude1-verdict-rp-${SHA_C.slice(0, 8)}.md`, text))).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      expect(item.latestReview).toMatchObject({ verdict: 'needs-fixes', issues_found: 2 });
      expect(item.freeze?.verdict).toBe('needs-fixes');
    });

    it('NEEDS FIXES creates a card without Promote: the server refuses to promote it', async () => {
      const file = write(`claude1-verdict-codex2-si-aop-${SHA_C.slice(0, 8)}-20261009.md`, VERDICT_NEEDS_FIXES);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      expect(item.freeze).toMatchObject({ sha: SHA_C, verdict: 'needs-fixes', reviewer_name: 'claude1', author_name: 'codex2' });
      const promoted = (await rq.promote(item.run.id));
      expect(promoted.ok).toBe(false);
      expect(!promoted.ok && promoted.error).toMatch(/Promotion blocked: verdict is 'needs-fixes'/);
      expect(vi.mocked(emit).mock.calls.some((c) => c[0] === 'review.promoted')).toBe(false);
    });

    it('a self-review is refused: no card when the reviewer is the author', async () => {
      const text = VERDICT_PASS.replace('reviewer Codex3', 'reviewer Claude2');
      const file = write(`claude2-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, text);
      const r = (await rf.ingestFreezeFile(file));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/self-review refused/);
      expect(rq.listPendingReviews()).toHaveLength(0);
      expect(rf.getFreeze(SHA_A)).toBeNull();
    });

    it('a freeze note without a verdict is stored, and the later verdict file completes the card with both links', async () => {
      const note = write(`codex2-freeze-si-aop-retained-${SHA_C.slice(0, 8)}-20261009.md`, FREEZE_REQUEST_ONLY);
      const stored = (await rf.ingestFreezeFile(note));
      expect(stored.ok && stored.data.effect).toBe('stored');
      expect(rq.listPendingReviews()).toHaveLength(0);
      const verdict = write(`claude1-verdict-codex2-si-aop-retained-${SHA_C.slice(0, 8)}-20261009.md`, VERDICT_NEEDS_FIXES.replace('VERDICT: NEEDS FIXES', 'VERDICT: PASS'));
      const r = (await rf.ingestFreezeFile(verdict));
      expect(r.ok && r.data.effect).toBe('card');
      const [item] = rq.listPendingReviews();
      expect(item.freeze).toMatchObject({ sha: SHA_C, verdict: 'pass', freeze_path: note, verdict_path: verdict, lane: 'wc-codex2-wavenetic-04420-composition', author_name: 'codex2', reviewer_name: 'claude1' });
    });

    it('attributes a SHA from the author checkout or release record, not from prose or another seat', async () => {
      const ales = db.insertAgent({
        name: 'ales-claude1', runtime: 'claude-code', tmux_session: 'wc-ales-claude1', workspace: null, mode: 'spawned', status: 'idle',
      });
      if (!ales.ok) throw new Error(ales.error);
      const codex2 = db.listAgents().find((a) => a.name === 'codex2');
      if (!codex2?.workspace) throw new Error('codex2');
      fs.mkdirSync(codex2.workspace, { recursive: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', codex2.workspace!, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).trim();
      git('init', '-q', '-b', 'wc-codex2-desk');

      const stolen = 'cab9ffe2' + 'ab'.repeat(16);
      const prose = `# Freeze note\n\nProject: wavepulse · Author: codex2\nThe changes were reviewed with wc-ales-claude1, held separately.\nLane: \`changes\`\n- Exact SHA: \`${stolen}\`\n`;
      expect((await rf.ingestFreezeText(prose, 'cab9ffe2-freeze.md')).ok).toBe(true);
      expect(rf.getFreeze(stolen)?.lane).toBe('wc-codex2-desk');
      expect((await rf.laneFromRunRecord({ sha: stolen, author_agent_id: codex2.id, run_id: null }))).toBe('wc-codex2-desk');

      db.getDb().prepare('UPDATE release_freezes SET lane = ? WHERE sha = ?').run('wc-ales-claude1', stolen);
      expect((await rf.ingestFreezeText(prose, 'cab9ffe2-freeze.md')).ok).toBe(true);
      expect(rf.getFreeze(stolen)?.lane).toBe('wc-codex2-desk');

      const feature = 'f00dcafe' + 'cd'.repeat(16);
      const explicit = `# Freeze note\n\nProject: wavepulse · Author: codex2\nLane: \`wc-feature\`\nAlso mentioned wc-ales-claude1.\n- Exact SHA: \`${feature}\`\n`;
      expect((await rf.ingestFreezeText(explicit, 'feature-freeze.md')).ok).toBe(true);
      expect(rf.getFreeze(feature)?.lane).toBe('wc-feature');

      const other = `# Freeze note\n\nProject: wavepulse · Author: codex2\nLane: \`wc-ales-claude1\`\n- Exact SHA: \`${stolen}\`\n`;
      expect((await rf.ingestFreezeText(other, 'other-seat-freeze.md')).ok).toBe(true);
      expect(rf.getFreeze(stolen)?.lane).toBe('wc-codex2-desk');

      const recorded = 'a1b2c3d4' + 'ef'.repeat(16);
      git('checkout', '-q', '-b', 'main');
      const rel = await import('./releases.js');
      rel.ensureReleaseTables();
      db.getDb().prepare(
        `INSERT INTO release_requests (id, sha, lane, target, origin, status) VALUES ('rel-1', ?, 'wc-codex2-record', 'staging', 'local', 'sent')`,
      ).run(recorded);
      const fromRecord = `# Freeze note\n\nProject: wavepulse · Author: codex2\nSource of the commits is held separately.\n- Exact SHA: \`${recorded}\`\n`;
      expect((await rf.ingestFreezeText(fromRecord, 'record-freeze.md')).ok).toBe(true);
      expect(rf.getFreeze(recorded)?.lane).toBe('wc-codex2-record');
    });

    it('uses Branch: when there is no Lane:, and a Fable run instead of a seat named in prose', async () => {
      const canary = '336a5008' + 'aa'.repeat(16);
      const note = `# Freeze\n\nProject: wavepulse · Author: codex2\nReviewed next to wc-codex3.\nBranch: canary-e2e-stage-v5\n- Exact SHA: \`${canary}\`\n`;
      expect(rf.laneFromLines(note.split('\n'))).toBe('canary-e2e-stage-v5');
      expect((await rf.ingestFreezeText(note, '336a5008-freeze.md')).ok).toBe(true);
      expect(rf.getFreeze(canary)?.lane).toBe('canary-e2e-stage-v5');
      expect(rf.isShaLane('6ed9192e')).toBe(true);
      expect(rf.laneFromLines(['Lane: `6ed9192e`'])).toBeNull();

      const fableDir = path.join(os.tmpdir(), `wc-fable-${process.pid}`);
      fs.rmSync(fableDir, { recursive: true, force: true });
      fs.mkdirSync(fableDir);
      const git = (...args: string[]) => execFileSync('git', ['-C', fableDir, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).trim();
      git('init', '-q', '-b', 'wc-fable');
      const fable = db.insertAgent({
        name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: fableDir, mode: 'spawned', status: 'idle',
      });
      const ales = db.insertAgent({
        name: 'ales-claude1', runtime: 'claude-code', tmux_session: 'wc-ales-claude1', workspace: null, mode: 'spawned', status: 'idle',
      });
      if (!fable.ok || !ales.ok) throw new Error('seed');
      const task = db.insertTask({ agent_id: fable.data.id, prompt: 'fable release' });
      if (!task.ok) throw new Error(task.error);
      const run = db.insertRun({ task_id: task.data.id, agent_id: fable.data.id });
      if (!run.ok) throw new Error(run.error);
      const stolen = 'cab9ffe2' + 'cd'.repeat(16);
      const prose = `# Freeze note\n\nProject: wavepulse · Author: ales-claude1\nThe changes were reviewed with wc-ales-claude1, held separately.\nLane: \`changes\`\n- Exact SHA: \`${stolen}\`\n`;
      expect((await rf.ingestFreezeText(prose, 'cab9ffe2-freeze.md')).ok).toBe(true);
      db.getDb().prepare(
        `UPDATE release_freezes SET lane = ?, author_agent_id = ?, run_id = ? WHERE sha = ?`,
      ).run('wc-ales-claude1', ales.data.id, run.data.id, stolen);
      expect((await rf.attributedLane(rf.getFreeze(stolen)!))).toBe('wc-fable');
      expect((await rf.applyNoteLabels(stolen, prose, 'cab9ffe2-freeze.md')).lane).toBe('wc-fable');
      expect(rf.getFreeze(stolen)?.lane).toBe('wc-fable');
      fs.rmSync(fableDir, { recursive: true, force: true });
    });

    it('a re-delivered file is idempotent: one card, one review row, no second event', async () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      const again = (await rf.ingestFreezeFile(file));
      expect(again.ok && again.data.effect).toBe('noop');
      const items = rq.listPendingReviews();
      expect(items).toHaveLength(1);
      expect(reviewRows(items[0].run.id)).toHaveLength(1);
      expect(vi.mocked(emit).mock.calls.filter((c) => c[0] === 'review.ai_completed')).toHaveLength(1);
    });

    it('a changed verdict on the same SHA (second reviewer, or a re-review) adds a review row, same card', async () => {
      write(`claude1-verdict-x-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES);
      expect((await rf.ingestFreezeFile(path.join(inbox, `claude1-verdict-x-${SHA_C.slice(0, 8)}.md`))).ok).toBe(true);
      const file = write(`claude1-verdict-x-r2-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES.replace('VERDICT: NEEDS FIXES', 'VERDICT: PASS'));
      const r = (await rf.ingestFreezeFile(file));
      expect(r.ok && r.data.effect).toBe('updated');
      const items = rq.listPendingReviews();
      expect(items).toHaveLength(1);
      expect(items[0].freeze?.verdict).toBe('pass');
      expect(items[0].latestReview?.verdict).toBe('pass');
      expect(reviewRows(items[0].run.id)).toHaveLength(2);
    });
  });

  describe('rules', () => {
    it('a newer commit on the same lane invalidates the older PASS: stale SHA is refused, even with an override reason', async () => {
      const old = write(`desk91-freeze-${SHA_B.slice(0, 8)}.md`, DESK91_FREEZE.replaceAll(SHA_A, SHA_B));
      expect((await rf.ingestFreezeFile(old)).ok).toBe(true);
      const [oldItem] = rq.listPendingReviews();
      const newer = write(`desk91-freeze-${SHA_A.slice(0, 8)}.md`, DESK91_FREEZE);
      expect((await rf.ingestFreezeFile(newer)).ok).toBe(true);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'stale', superseded_by: SHA_A });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.superseded', 'run', oldItem.run.id, expect.objectContaining({ sha: SHA_B, superseded_by: SHA_A }), null);
      const r = (await rq.promote(oldItem.run.id, { overrideReason: 'ship it anyway' }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(/stale/);
      const items = rq.listPendingReviews();
      expect(items.map((i) => i.freeze?.status).sort()).toEqual(['open', 'stale']);
    });

    it('a verdict-only row (no lane line) is superseded by a newer freeze for the same desk', async () => {
      // claude2's verdict file for Desk #108 carries no Lane: line → lane null
      const v = write(`claude2-verdict-pd108-s1-${SHA_B.slice(0, 8)}.md`, `# Verdict: Codex2 PD-108 S1 (exact SHA ${SHA_B})\nProject: wavepulse · reviewer Claude2 · Author: codex2\n\n- [HIGH] renumber the migrations\n\nVERDICT: NEEDS FIXES\n`);
      expect((await rf.ingestFreezeFile(v)).ok).toBe(true);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'open', lane: null, desk: 108, verdict: 'needs-fixes' });
      // codex2's newer freeze for Desk #108 on its lane
      const note = write(`codex2-pd108-s1-freeze-${SHA_A.slice(0, 8)}.md`, `# Codex2 freeze — PD-108 S1 r2\n\nProject: wavepulse · Author: codex2 · Desk #108\n- Branch: \`wc-codex2-pd108\`\n- Exact SHA: \`${SHA_A}\`\n\nIndependent reviewer: Claude2.\n`);
      expect((await rf.ingestFreezeFile(note)).ok).toBe(true);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'stale', superseded_by: SHA_A });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.superseded', 'run', expect.any(String), expect.objectContaining({ sha: SHA_B, superseded_by: SHA_A, by: 'desk' }), null);
    });

    it('reconcile marks older open freezes per desk stale even when the newer one was ingested before the rule', async () => {
      const old = write(`claude2-verdict-pd108-${SHA_B.slice(0, 8)}.md`, `# Verdict: Codex2 PD-108 (exact SHA ${SHA_B})\nProject: wavepulse · reviewer Claude2 · Author: codex2\n\nVERDICT: NEEDS FIXES\n`);
      expect((await rf.ingestFreezeFile(old)).ok).toBe(true);
      const newer = write(`codex2-pd108-freeze-${SHA_A.slice(0, 8)}.md`, `# Codex2 freeze PD-108 r2\nProject: wavepulse · Author: codex2 · Desk #108\n- Exact SHA: \`${SHA_A}\`\n`);
      expect((await rf.ingestFreezeFile(newer)).ok).toBe(true);
      // simulate rows that predate the rule: reopen the old one
      db.getDb().prepare("UPDATE release_freezes SET status = 'open', superseded_by = NULL WHERE sha = ?").run(SHA_B);
      expect(rf.getFreeze(SHA_B)!.status).toBe('open');
      expect(rf.reconcileSuperseded()).toBe(1);
      expect(rf.getFreeze(SHA_B)).toMatchObject({ status: 'stale', superseded_by: SHA_A });
      expect(rf.getFreeze(SHA_A)!.status).toBe('open');
      expect(rf.reconcileSuperseded()).toBe(0);
    });

    it('a SHA inside an unreleased candidate branch is "in candidate"; a released candidate (on main) no longer counts', async () => {
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
      expect((await rf.candidateFor('wavepulse', laneSha))).toEqual({ ref: 'origin/fable/rc-0443-2', name: 'fable/rc-0443-2' });
      expect((await rf.candidateFor('wavepulse', base))).toBeNull(); // on main already (released candidate ignored)
      expect((await rf.isOnMain('wavepulse', laneSha))).toBe(false);
      rf.setFetchDisabledForTest(false);
      delete projectsConfig.wavepulse.repo;
      delete projectsConfig.wavepulse.candidate_refs;
    });

    it('a SHA that is already on the project main is closed as merged, its queue card approved', async () => {
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
        expect((await rf.ingestFreezeFile(f)).ok).toBe(true);
      }
      expect((await rf.isOnMain('wavepulse', merged))).toBe(true);
      expect((await rf.isOnMain('wavepulse', unmerged))).toBe(false);
      expect((await rf.isOnMain('wavepulse', 'f'.repeat(40)))).toBeNull();
      expect((await rf.reconcileMerged())).toBe(1);
      expect(rf.getFreeze(merged)).toMatchObject({ status: 'merged', superseded_by: 'main' });
      expect(rf.getFreeze(unmerged)).toMatchObject({ status: 'open' });
      const cards = rq.listPendingReviews();
      expect(cards.map((c) => c.freeze?.sha)).toEqual([unmerged]);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.superseded', 'run', expect.any(String), expect.objectContaining({ sha: merged, superseded_by: 'main', by: 'merged' }), null);
      delete projectsConfig.wavepulse.repo;
    });

    it('retry and hand-off do not apply to a freeze card', async () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
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
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      const [item] = rq.listPendingReviews();

      const { runWithActor } = await import('./request-context.js');
      const r = await runWithActor('owner', async () => (await rq.promote(item.run.id)), { admin: true });
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

    it('Promote never bypasses the rules through require_pass_to_promote=false', async () => {
      reviewConfig.require_pass_to_promote = false;
      const file = write(`claude1-verdict-codex2-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      expect((await rq.promote(item.run.id)).ok).toBe(false);
      // an admin override with a stored reason still works for a non-PASS (the route checks the role)
      const r = (await rq.promote(item.run.id, { overrideReason: 'hotfix agreed with Denis' }));
      expect(r.ok).toBe(true);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.promoted', 'run', item.run.id, expect.objectContaining({ override_reason: 'hotfix agreed with Denis' }));
    });

    it('Reject removes the card with a reason, and a re-delivered file does not revive it', async () => {
      const file = write(`codex3-verdict-desk91-${SHA_A.slice(0, 8)}-20261009.md`, VERDICT_PASS);
      expect((await rf.ingestFreezeFile(file)).ok).toBe(true);
      const [item] = rq.listPendingReviews();
      const r = rq.reject(item.run.id, { reason: 'wrong base, refreeze on main' });
      expect(r.ok).toBe(true);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('review.rejected', 'run', item.run.id, expect.objectContaining({ reason: 'wrong base, refreeze on main', freeze: expect.objectContaining({ sha: SHA_A }) }));
      expect(rf.getFreeze(SHA_A)).toMatchObject({ status: 'rejected', decision_reason: 'wrong base, refreeze on main' });
      expect(rq.listPendingReviews()).toHaveLength(0);
      const again = (await rf.ingestFreezeFile(file));
      expect(again.ok && again.data.effect).toBe('noop');
      expect(rq.listPendingReviews()).toHaveLength(0);
    });
  });

  describe('inbox watcher and backfill', () => {
    it('backfill imports today\'s PASS verdicts and freezes only: yesterday\'s files and NEEDS FIXES stay out', async () => {
      const yesterday = Date.now() - 36 * 3600 * 1000;
      write(`desk91-freeze-${SHA_B.slice(0, 8)}.md`, DESK91_FREEZE.replaceAll(SHA_A, SHA_B).replace('wc-claude2', 'wc-old-lane'), yesterday);
      write(`claude1-verdict-codex2-${SHA_C.slice(0, 8)}.md`, VERDICT_NEEDS_FIXES);
      write(`desk91-freeze-${SHA_A.slice(0, 8)}.md`, DESK91_FREEZE);
      write('notes.md', 'unrelated');
      (await rf.backfillFreezes());
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
      await rf.pendingInboxForTest();
      const items = rq.listPendingReviews();
      expect(items).toHaveLength(1);
      expect(items[0].freeze?.sha).toBe(SHA_A);
      rf.onInboxEvent(inbox, name, 10);               // fs.watch fires several events per write
      await new Promise((res) => setTimeout(res, 60));
      await rf.pendingInboxForTest();
      expect(reviewRows(items[0].run.id)).toHaveLength(1);
    });

    it('startFreezeWatchers watches the configured inbox and stops cleanly', async () => {
      (await rf.startFreezeWatchers());
      rf.stopFreezeWatchers();
      reviewConfig.freeze_inbox = [path.join(tmp, 'missing')];
      (await rf.startFreezeWatchers()); // missing dir: warns, no throw
    });
  });
});
