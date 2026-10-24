import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOpsLanes } from './ops-lanes-config.js';
import { MAX_HEARTBEAT_BYTES, collectOnce, resetOpsLanesForTest, startOpsLanes, stopOpsLanes } from './ops-lanes.js';

const SECRET = 'SUPER_SECRET_TOKEN sk-do-not-leak';
const NOW = Date.parse('2026-10-24T20:00:00.000Z');

describe('ops lanes collector', () => {
  let tmp = '';

  afterEach(() => {
    resetOpsLanesForTest();
    vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = '';
  });

  it('stays off the synchronous process path and reads only heartbeat JSON', () => {
    const src = fs.readFileSync(new URL('./ops-lanes.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\b(execFileSync|execSync|spawnSync|Atomics\.wait|readFileSync)\b/);
    expect(src).toContain('fs.promises.readFile');
    expect(src).toContain('`${role}.json`');
  });

  it('reads the configured JSON files, redacts them, and ignores every other path', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ops-'));
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    const link = path.join(tmp, 'lanes');
    fs.symlinkSync(real, link);
    const receipt = path.join(real, 'receipt.txt');
    fs.writeFileSync(receipt, SECRET);
    fs.writeFileSync(path.join(real, 'notes.json'), JSON.stringify({ leak: SECRET }));
    fs.writeFileSync(path.join(real, 'pilot.json'), JSON.stringify({
      bot: 'pilot',
      role: 'pilot',
      model: 'opus',
      key_status: 'ok',
      current_job: `password=${SECRET}`,
      heartbeat_at: '2026-10-24T19:59:30.000Z',
      last_receipt_path: receipt,
      note: SECRET,
    }));
    fs.writeFileSync(path.join(real, 'stager.json'), '{');
    fs.writeFileSync(path.join(real, 'scribe-hipsl.json'), `${JSON.stringify({ bot: 'scribe-hipsl', current_job: SECRET })} ${'x'.repeat(MAX_HEARTBEAT_BYTES)}`);

    const readFile = vi.spyOn(fs.promises, 'readFile');
    const report = await collectOnce({
      now: () => NOW,
      config: resolveOpsLanes({
        ops_lanes: { dir: link, stale_min: 2, roles: ['pilot', 'stager', 'scout', 'scribe-hipsl'] },
      }),
    });

    const paths = readFile.mock.calls.map((call) => String(call[0]));
    expect(paths.some((file) => file.endsWith(`${path.sep}pilot.json`))).toBe(true);
    expect(paths.some((file) => file.endsWith(`${path.sep}stager.json`))).toBe(true);
    expect(paths.some((file) => file.endsWith('receipt.txt'))).toBe(false);
    expect(paths.some((file) => file.endsWith('notes.json'))).toBe(false);
    expect(paths.some((file) => file.endsWith('scribe-hipsl.json'))).toBe(false);

    const byId = Object.fromEntries(report.lanes.map((lane) => [lane.id, lane]));
    expect(report.dir_error).toBeNull();
    expect(byId.pilot?.file).toBe('ok');
    expect(byId.pilot?.red).toBe(false);
    expect(byId.pilot?.current_job).toContain('[redacted]');
    expect(byId.pilot?.last_receipt_path).toBe(receipt);
    expect(byId.stager?.file).toBe('invalid');
    expect(byId.stager?.red).toBe(true);
    expect(byId.stager?.role).toBe('unknown');
    expect(byId.scout?.file).toBe('missing');
    expect(byId.scout?.reasons).toEqual(['missing']);
    expect(byId['scribe-hipsl']?.file).toBe('invalid');
    const body = JSON.stringify(report);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(link);
  });

  it('reports a missing directory without throwing', async () => {
    const report = await collectOnce({
      now: () => NOW,
      config: resolveOpsLanes({ ops_lanes: { dir: path.join(os.tmpdir(), 'wc-ops-missing-dir'), roles: ['pilot'] } }),
    });
    expect(report.dir_error).toBe('missing');
    expect(report.lanes[0]).toMatchObject({ id: 'pilot', file: 'missing', red: true, role: 'unknown' });
  });

  it('collects again after 10 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const realpath = vi.spyOn(fs.promises, 'realpath').mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    try {
      startOpsLanes();
      await vi.waitFor(() => expect(realpath.mock.calls.length).toBe(1));
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(realpath.mock.calls.length).toBe(2));
    } finally {
      stopOpsLanes();
      realpath.mockRestore();
      vi.useRealTimers();
    }
  });
});
