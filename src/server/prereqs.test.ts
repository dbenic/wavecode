import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projects: Record<string, Record<string, unknown>> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ projects, review: {}, releases: {}, artifacts: { storage: '' }, paths: {} })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import * as db from './db.js';
import { ensureReleaseFreezeTable } from './release-freezes.js';
import { declaredPrereqs, goSteps, parsePrereqBlock, productionPrereqGate, runPrereqChecks, stepsPrompt, unionPrereqs, type PrereqDecl } from './prereqs.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

const NOTE = `
\`\`\`yaml
prereqs:
  - id: db_roles_applied
    order: 20
  - id: prod_owner_count>=2
    order: 10
  - id: code_deploy
    order: 100
    kind: code
\`\`\`
`;

describe('prereqs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-prereq-'));
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    for (const key of Object.keys(projects)) delete projects[key];
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parses the freeze fence and keeps order, appending code_deploy only when none was declared', () => {
    const decls = parsePrereqBlock(NOTE);
    expect(decls.map((d) => d.id)).toEqual(['prod_owner_count>=2', 'db_roles_applied', 'code_deploy']);
    expect(decls.find((d) => d.id === 'code_deploy')?.kind).toBe('code');
    const checksOnly = decls.filter((d) => d.kind !== 'code');
    expect(goSteps(checksOnly).map((s) => s.id)).toEqual(['prod_owner_count>=2', 'db_roles_applied', 'code_deploy']);
    expect(stepsPrompt(goSteps(decls))).toContain('Stop on the first failure. Leave the previous state live.');
    expect(stepsPrompt(goSteps(decls))).toContain('1. prod_owner_count>=2');
    expect(stepsPrompt(goSteps(decls))).toContain('3. code_deploy — deploy this exact SHA');
  });

  it('unions candidate lanes by earliest order and keeps one copy of an id', () => {
    const a: PrereqDecl[] = [{ id: 'db_roles_applied', order: 20, kind: 'check' }];
    const b: PrereqDecl[] = [
      { id: 'prod_owner_count>=2', order: 10, kind: 'check' },
      { id: 'db_roles_applied', order: 30, kind: 'check' },
    ];
    expect(unionPrereqs([a, b]).map((d) => `${d.id}@${d.order}`)).toEqual([
      'prod_owner_count>=2@10',
      'db_roles_applied@20',
    ]);
  });

  it('stops at the first failing check and reads an ndjson field', () => {
    const sha = 'a'.repeat(40);
    const marker = path.join(tmp, 'later');
    projects.demo = {
      workspace_match: '**/*',
      prereq_checks: {
        first: { command: ['node', '-e', 'process.exit(2)'] },
        later: { command: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] },
        'prod_owner_count>=2': {
          command: ['node', '-e', 'console.log(JSON.stringify({prod_owner_count:1}))'],
          type: 'ndjson', field: 'prod_owner_count', compare: '>=', value: 2,
        },
      },
    };
    const stopped = runPrereqChecks('demo', sha, [
      { id: 'first', order: 1, kind: 'check' },
      { id: 'later', order: 2, kind: 'check' },
    ]);
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.error).toMatch(/prereq first failed/);
    expect(fs.existsSync(marker)).toBe(false);

    const low = runPrereqChecks('demo', sha, [{ id: 'prod_owner_count>=2', order: 1, kind: 'check' }]);
    expect(low.ok).toBe(false);

    (projects.demo.prereq_checks as { 'prod_owner_count>=2': { command: string[] } })['prod_owner_count>=2'].command = [
      'node', '-e', 'console.log(JSON.stringify({prod_owner_count:2}))',
    ];
    expect(runPrereqChecks('demo', sha, [{ id: 'prod_owner_count>=2', order: 1, kind: 'check' }]).ok).toBe(true);

    (projects.demo.prereq_checks as { 'prod_owner_count>=2': { command: string[] } })['prod_owner_count>=2'].command = [
      'node', '-e', 'console.log(JSON.stringify({prod_owner_count:9})); process.exit(21)',
    ];
    expect(runPrereqChecks('demo', sha, [{ id: 'prod_owner_count>=2', order: 1, kind: 'check' }]).ok).toBe(false);
  });

  it('refuses Promote when a declared prereq has no check, and allows it when every check passes', () => {
    const sha = 'b'.repeat(40);
    const file = path.join(tmp, 'freeze.md');
    fs.writeFileSync(file, NOTE);
    projects.demo = { workspace_match: '**/*', repo: tmp };
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, freeze_path, status) VALUES (?, 'demo', 'wc-a', ?, 'open')`,
    ).run(sha, file);
    const missing = productionPrereqGate('demo', sha, 'denis');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('prereq prod_owner_count>=2 has no check');

    projects.demo.prereq_checks = {
      'prod_owner_count>=2': { command: ['node', '-e', 'process.exit(0)'] },
      db_roles_applied: { command: ['node', '-e', 'process.exit(0)'] },
    };
    const passed = productionPrereqGate('demo', sha, 'denis');
    expect(passed.ok).toBe(true);
    if (passed.ok) expect(passed.steps?.map((s) => s.id)).toEqual(['prod_owner_count>=2', 'db_roles_applied', 'code_deploy']);
    expect(productionPrereqGate('demo', 'c'.repeat(40), 'denis')).toEqual({ ok: true, steps: null });
  });

  it('unions freeze notes whose SHAs are contained in a candidate', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'wc-a');
    fs.writeFileSync(path.join(repo, 'a-only.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane a');
    const shaA = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', base);
    git(repo, 'checkout', '-q', '-b', 'wc-b');
    fs.writeFileSync(path.join(repo, 'b-only.txt'), 'b');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane b');
    const shaB = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '--no-ff', '--no-edit', '-m', 'candidate', 'wc-a');
    git(repo, 'merge', '--no-ff', '--no-edit', '-m', 'candidate', 'wc-b');
    const candidate = git(repo, 'rev-parse', 'HEAD');
    const fileA = path.join(tmp, 'a-freeze.md');
    const fileB = path.join(tmp, 'b-freeze.md');
    fs.writeFileSync(fileA, '```yaml\nprereqs:\n  - id: db_roles_applied\n    order: 20\n```\n');
    fs.writeFileSync(fileB, '```yaml\nprereqs:\n  - id: prod_owner_count>=2\n    order: 10\n  - id: db_roles_applied\n    order: 30\n```\n');
    const insert = db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, freeze_path, status) VALUES (?, 'demo', ?, ?, 'open')`,
    );
    insert.run(shaA, 'wc-a', fileA);
    insert.run(shaB, 'wc-b', fileB);
    projects.demo = { workspace_match: '**/*', repo };
    expect(declaredPrereqs('demo', candidate).map((d) => `${d.id}@${d.order}`)).toEqual([
      'prod_owner_count>=2@10',
      'db_roles_applied@20',
    ]);
  });
});
