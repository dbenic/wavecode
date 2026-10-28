import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const review: { freeze_inbox: string[]; first_pass?: { dir?: string } } = { freeze_inbox: [] };
const projects: Record<string, Record<string, unknown>> = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ review, projects, releases: {}, peers: {}, paths: {}, artifacts: { storage: '' }, notifications: {} })),
}));

import * as db from './db.js';
import {
  candidateBase, candidateFileName, candidateRequested, candidateResultFor, isCandidateFileName, listCandidateReviews,
  overdueCandidateReviews, parseCandidateReview, recordCandidateReviewFile, requestCandidateReview, candidateHooks,
} from './candidate-review.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}
function seat(name: string, extra: Partial<db.Agent> = {}): db.Agent {
  return {
    id: extra.id ?? name, name, runtime: extra.runtime ?? 'codex', tmux_session: `tmux-${name}`, workspace: null,
    mode: 'spawned', status: 'idle', model: null, effort: null, profile: null, role: null, alias: extra.alias ?? null, persona: null, created_at: '',
  } as db.Agent;
}

describe('candidate review files', () => {
  it('names the file by sha8 and UTC day, and recognises it', () => {
    const name = candidateFileName('A9D705D1B92D6B23CE7D56F41179CF4995B7CEC8', new Date('2026-10-28T06:30:00Z'));
    expect(name).toBe('wave-candidate-a9d705d1-20261028.md');
    expect(isCandidateFileName(`/home/wave/inbox/${name}`)).toBe(true);
    expect(isCandidateFileName('wave-firstpass-a9d705d1-20261028.md')).toBe(false);
    expect(isCandidateFileName('codex3-verdict-a9d705d1.md')).toBe(false);
  });

  it('parses the last CANDIDATE REVIEW line, skips the instruction line, counts tagged issues, reads the main SHA', () => {
    const text = [
      '# Candidate review a9d705d1 on main',
      '- Main SHA: a9d705d1b92d6b23ce7d56f41179cf4995b7cec8',
      '- Since: 1111111111111111111111111111111111111111',
      'end this file with exactly one line: CANDIDATE REVIEW: PASS, or CANDIDATE REVIEW: NEEDS FIXES.',
      'ISSUES:',
      '- [HIGH] src/x.ts:10 — bug',
      '- [MED] src/y.ts:2 — missing test',
      '- plain note',
      'Seat: @codex2',
      '**CANDIDATE REVIEW: NEEDS FIXES**',
    ].join('\n');
    expect(parseCandidateReview(text, 'wave-candidate-a9d705d1-20261028.md')).toEqual({
      sha: 'a9d705d1b92d6b23ce7d56f41179cf4995b7cec8', result: 'needs-fixes', issues: 2, file: 'wave-candidate-a9d705d1-20261028.md', seat: 'codex2',
    });
    expect(parseCandidateReview('nothing yet\nCANDIDATE REVIEW: PASS or CANDIDATE REVIEW: NEEDS FIXES', 'wave-candidate-a9d705d1-20261028.md')).toBeNull();
    expect(parseCandidateReview('CANDIDATE REVIEW: PASS', 'notes.md')).toBeNull();
  });
});

describe('rolling candidate review', () => {
  let tmp: string;
  let repo: string;
  let dir: string;
  const delivered: Array<{ to: string; text: string }> = [];

  function commitOnMain(file: string, msg: string): string {
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, file), msg);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', msg);
    return git(repo, 'rev-parse', 'HEAD');
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cand-'));
    repo = path.join(tmp, 'repo');
    dir = path.join(tmp, 'freezes');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    delivered.length = 0;
    projects.wave = { repo, pipeline: { auto_review: true, freeze_dir: dir } };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => {
    candidateHooks.onResult = null;
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
  });

  function ask(sha: string, mainBefore: string | null, reviewer: db.Agent | null = seat('toni'), author: db.Agent | null = seat('ales')) {
    return requestCandidateReview({
      project: 'wave', sha, repo, remote: 'origin', lane: 'wc-ales-x', author, mainBefore, productionSha: null,
      pick: () => reviewer, deliver: (agent, text) => { delivered.push({ to: agent.name, text }); },
    });
  }

  it('first time: the diff since the merge base; next time: since the last answered review; the request file carries the merges', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const m1 = commitOnMain('one.txt', 'merge one');
    const first = await ask(m1, base);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.base).toBe(base);
    expect(first.data.merges).toBe(1);
    expect(first.data.files).toBe(1);
    expect(first.data.reviewer).toBe('toni');
    expect(fs.existsSync(first.data.file)).toBe(true);
    const body = fs.readFileSync(first.data.file, 'utf8');
    expect(body).toContain(`- Main SHA: ${m1}`);
    expect(body).toContain(`- Since: ${base}`);
    expect(body).toContain('merge one');
    expect(body).toContain('one.txt');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].to).toBe('toni');
    expect(delivered[0].text).toContain(`git diff ${base}..${m1}`);
    expect(delivered[0].text).toContain('CANDIDATE REVIEW: PASS');
    expect(candidateRequested(m1)?.reviewer).toBe('toni');
    // asked again for the same main: nothing
    expect(await ask(m1, base)).toEqual({ ok: false, error: 'already requested' });

    // the seat answers in the file
    fs.appendFileSync(first.data.file, '\nISSUES:\n- [LOW] one.txt:1 — nit\nSeat: @toni\nCANDIDATE REVIEW: PASS\n');
    const seen: string[] = [];
    candidateHooks.onResult = (r) => seen.push(`${r.sha.slice(0, 8)}:${r.result}:${r.issues}`);
    const rec = recordCandidateReviewFile(first.data.file);
    expect(rec).toMatchObject({ sha: m1, result: 'pass', issues: 1, seat: 'toni' });
    expect(seen).toEqual([`${m1.slice(0, 8)}:pass:1`]);
    expect(recordCandidateReviewFile(first.data.file)).toMatchObject({ sha: m1 }); // recorded once
    expect(candidateResultFor(m1)?.result).toBe('pass');

    // the next merge is reviewed from the answered one, not from the old base or main_before
    const m2 = commitOnMain('two.txt', 'merge two');
    expect(await candidateBase('wave', repo, m2, base, null)).toBe(m1);
    const second = await ask(m2, base);
    expect(second.ok && second.data.base).toBe(m1);
    expect(second.ok && second.data.merges).toBe(1);
    const list = listCandidateReviews('wave');
    expect(list.map((r) => [r.sha.slice(0, 8), r.result?.result ?? null])).toEqual([[m2.slice(0, 8), null], [m1.slice(0, 8), 'pass']]);
  });

  it('an unanswered request is folded into the next one and never chased; one that is overdue is noted once', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    const m1 = commitOnMain('one.txt', 'merge one');
    const first = await ask(m1, base);
    expect(first.ok).toBe(true);
    const m2 = commitOnMain('two.txt', 'merge two');
    const second = await ask(m2, base);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.base).toBe(base); // nothing answered yet: still from the merge base
    expect(second.data.merges).toBe(2);
    expect(second.data.folded).toBe(m1);
    expect(delivered[1].text).toContain(`It includes ${m1.slice(0, 8)}, which you can skip now.`);
    const list = listCandidateReviews('wave');
    expect(list.find((r) => r.sha === m1)?.superseded_by).toBe(m2);
    // overdue: the folded one is skipped, the live one is noted once
    const later = second.data.atMs + 46 * 60_000;
    expect(overdueCandidateReviews(later).map((r) => r.sha)).toEqual([m2]);
    expect(overdueCandidateReviews(later + 60_000)).toEqual([]);
    expect(listCandidateReviews('wave').find((r) => r.sha === m2)?.overdue).toBe(true);
  });

  it('refuses without a base, a directory, a reviewer, or a delta', async () => {
    const base = git(repo, 'rev-parse', 'HEAD');
    expect(await ask(base, null)).toEqual({ ok: false, error: 'no base' });
    const m1 = commitOnMain('one.txt', 'merge one');
    expect(await ask(m1, base, null)).toEqual({ ok: false, error: 'no reviewer' });
    (projects.wave as { pipeline: Record<string, unknown> }).pipeline = { auto_review: true };
    expect(await ask(m1, base)).toEqual({ ok: false, error: 'no directory' });
    (projects.wave as { pipeline: Record<string, unknown> }).pipeline = { auto_review: true, freeze_dir: dir, candidate_review: false };
    expect(await ask(m1, base)).toEqual({ ok: false, error: 'off' });
    (projects.wave as { pipeline: Record<string, unknown> }).pipeline = { auto_review: false, freeze_dir: dir, candidate_review: true };
    const ok = await ask(m1, base);
    expect(ok.ok).toBe(true);
  });
});
