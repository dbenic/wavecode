import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fillArgv, parseProgressLine, type ProgressLine } from './staging-progress.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'staging-progress');
const SHA = 'abc123abc123abc123abc123abc123abc123abcd';

function lines(name: string): ProgressLine[] {
  return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').map(parseProgressLine).filter((l): l is ProgressLine => l !== null);
}

describe('parseProgressLine', () => {
  it('ignores unknown fields and keeps schema v1', () => {
    const parsed = parseProgressLine('{"v":1,"phase":"build","status":"heartbeat","deploy_id":"d1","elapsed_s":20,"log":"deploy.log","caller":"ci","simulated":true,"extra":{"n":1}}');
    expect(parsed).toEqual({ deploy_id: 'd1', phase: 'build', status: 'heartbeat' });
    expect(parsed).not.toHaveProperty('elapsed_s');
    expect(parsed).not.toHaveProperty('log');
  });

  it('skips blank lines, bad JSON, non-objects, and any schema other than v1', () => {
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine('   ')).toBeNull();
    expect(parseProgressLine('not json')).toBeNull();
    expect(parseProgressLine('[]')).toBeNull();
    expect(parseProgressLine('"phase"')).toBeNull();
    expect(parseProgressLine('{"v":2,"phase":"build","status":"ok","deploy_id":"d1"}')).toBeNull();
    expect(parseProgressLine('{"phase":1,"status":"ok","deploy_id":"d1"}')).toBeNull();
    expect(parseProgressLine('{"phase":"build","status":"nope","deploy_id":"d1"}')).toBeNull();
    expect(parseProgressLine('{"phase":"build","status":"ok"}')).toBeNull();
    // v may be omitted; the line is still v1-shaped
    expect(parseProgressLine('{"phase":"lock","status":"ok","deploy_id":"d1"}')).toEqual({ deploy_id: 'd1', phase: 'lock', status: 'ok' });
  });

  it('reads a success stream, including a null rollback and the done line', () => {
    const all = lines('success.ndjson');
    expect(all.map((l) => `${l.phase}:${l.status}`)).toEqual([
      'queued:start', 'lock:start', 'lock:ok', 'fetch:ok', 'tests:skip', 'predeploy_dump:skip',
      'checkout:ok', 'deps:skip', 'build:start', 'build:heartbeat', 'build:ok', 'reload_migrate:ok',
      'verify:ok', 'pin:ok', 'done:ok',
    ]);
    const done = all[all.length - 1];
    expect(done).toMatchObject({
      phase: 'done', status: 'ok', version: '1.2.3', url: 'https://staging.example/app',
      pin_until: '2026-10-12T18:00:00Z', rollback_to: null, staging_sha: SHA, deploy_id: '20261012T120000Z-abc123abc',
    });
    expect(done).not.toHaveProperty('error');
  });

  it('keeps the failing phase detail and the terminal rollback', () => {
    const all = lines('failed.ndjson');
    const fail = all.find((l) => l.phase === 'build' && l.status === 'fail');
    expect(fail?.error).toEqual({ code: 'BUILD', step_rc: 13, msg: 'build failed in fixture' });
    const terminal = all[all.length - 1];
    expect(terminal).toMatchObject({
      phase: 'failed', status: 'fail', version: '1.2.3', pin_until: null,
      rollback_status: 'ok', url: 'https://staging.example/app',
    });
  });

  it('treats an already-current SHA as checkout and build skips', () => {
    const all = lines('same-sha.ndjson');
    expect(all.find((l) => l.phase === 'checkout')?.status).toBe('skip');
    expect(all.find((l) => l.phase === 'build')?.status).toBe('skip');
    expect(all[all.length - 1].phase).toBe('done');
  });
});

describe('fillArgv', () => {
  const template = ['sudo', 'staging-deploy', '--exact-sha', '{sha}', '--progress-json', '--lane', '{lane}', '--desk', '{desk}'];

  it('drops an empty lane or desk and the flag in front of it', () => {
    expect(fillArgv(template, { sha: SHA, lane: null, desk: '' })).toEqual([
      'sudo', 'staging-deploy', '--exact-sha', SHA, '--progress-json',
    ]);
  });

  it('fills sha, lane, desk, and deploy id without a shell', () => {
    expect(fillArgv(template, { sha: SHA, lane: 'lane-a', desk: '7' })).toEqual([
      'sudo', 'staging-deploy', '--exact-sha', SHA, '--progress-json', '--lane', 'lane-a', '--desk', '7',
    ]);
    expect(fillArgv(['staging-deploy', 'watch', '{deploy_id}'], { deploy_id: '20261012T120000Z-abc123abc' })).toEqual([
      'staging-deploy', 'watch', '20261012T120000Z-abc123abc',
    ]);
    expect(fillArgv(['staging-deploy', '--exact-sha={sha}'], { sha: SHA })).toEqual([
      'staging-deploy', `--exact-sha=${SHA}`,
    ]);
  });
});
