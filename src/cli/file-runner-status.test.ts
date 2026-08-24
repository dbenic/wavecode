import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../server/config.js', () => ({
  getConfig: vi.fn(() => ({
    server: { port: 3777, host: '0.0.0.0' },
    auth: { fallback_token: 'test-token' },
    paths: { transcripts_root: path.join(os.tmpdir(), 'wavecode-status-unused', 'transcripts') },
    notifications: { web_push: false, ntfy_topic: null, telegram_bot_token: null, telegram_chat_id: null },
  })),
}));

vi.mock('../server/notifications.js', () => ({
  notify: vi.fn(async () => undefined),
}));

import {
  STALE_AFTER_MS,
  buildFileRunnerSnapshot,
  fetchFileRunnerSnapshot,
  notifyIfChanged,
  parseableResultLastLine,
  runFileRunnerStatus,
  type FileRunnerStatusSnapshot,
} from './file-runner-status.js';

const START = '2026-08-24T10:00:00.000Z';

function snapshot(overrides: Partial<FileRunnerStatusSnapshot> = {}): FileRunnerStatusSnapshot {
  return {
    running: [{
      id: 'task-1',
      agent: 'wavepulse-fable-file',
      run_id: 'run-1',
      phase: 'running',
      started_at: START,
    }],
    runs: [{
      run_id: 'run-1',
      task_id: 'task-1',
      agent: 'wavepulse-fable-file',
      phase: 'running',
      last_line: 'writing tests',
      result_last_line: null,
      started_at: START,
    }],
    seats: [
      { name: 'wavepulse-fable-file', status: 'working' },
      { name: 'wavepulse-opus-file', status: 'idle' },
    ],
    ...overrides,
  };
}

describe('file-runner-status stamp compare', () => {
  let tmpDir: string;
  let stampPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-status-stamp-'));
    stampPath = path.join(tmpDir, 'status-stamp.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints nothing on an identical snapshot', () => {
    const now = Date.parse(START) + 5 * 60 * 1000;
    const first = notifyIfChanged(stampPath, snapshot(), now);
    expect(first.output).toBeNull();
    expect(first.events).toEqual([]);

    const again = notifyIfChanged(stampPath, snapshot(), now);
    expect(again.output).toBeNull();
    expect(again.events).toEqual([]);
  });

  it('prints a RESULT event when a result.txt last line appears', () => {
    const now = Date.parse(START) + 8 * 60 * 1000;
    expect(notifyIfChanged(stampPath, snapshot(), now).output).toBeNull();

    const withResult = snapshot({
      running: [],
      runs: [{
        run_id: 'run-1',
        task_id: 'task-1',
        agent: 'wavepulse-fable-file',
        phase: 'done',
        last_line: 'done',
        result_last_line: 'RESULT: PASS',
        started_at: START,
      }],
      seats: [
        { name: 'wavepulse-fable-file', status: 'idle' },
        { name: 'wavepulse-opus-file', status: 'idle' },
      ],
    });

    const changed = notifyIfChanged(stampPath, withResult, now);
    expect(changed.output).toBeTruthy();
    expect(changed.output).toContain('"kind":"RESULT"');
    expect(changed.output).toContain('RESULT: PASS');
    expect(changed.events.some((event) => event.kind === 'RESULT' && event.result_last_line === 'RESULT: PASS')).toBe(true);
    expect(changed.events.some((event) => event.kind === 'phase' && event.phase === 'done')).toBe(true);

    const again = notifyIfChanged(stampPath, withResult, now);
    expect(again.output).toBeNull();
  });

  it('prints STALE after 40 minutes with no result.txt and does not invent RESULT: FAIL', () => {
    const t0 = Date.parse(START) + 5 * 60 * 1000;
    expect(notifyIfChanged(stampPath, snapshot(), t0).output).toBeNull();

    const staleAt = Date.parse(START) + STALE_AFTER_MS + 1000;
    const stale = notifyIfChanged(stampPath, snapshot(), staleAt);
    expect(stale.output).toBeTruthy();
    expect(stale.output).toContain('"kind":"STALE"');
    expect(stale.output).not.toContain('RESULT: FAIL');
    expect(stale.events).toEqual([
      expect.objectContaining({
        kind: 'STALE',
        run_id: 'run-1',
        result_last_line: null,
      }),
    ]);
    expect(parseableResultLastLine(null)).toBeNull();

    const stillStale = notifyIfChanged(stampPath, snapshot(), staleAt + 60_000);
    expect(stillStale.output).toBeNull();
  });
});

describe('buildFileRunnerSnapshot', () => {
  it('keeps file-runner seats and presentFileRun fields without inventing a RESULT', () => {
    const snapshot = buildFileRunnerSnapshot({
      agents: [
        { id: 'a1', name: 'wavepulse-fable-file', mode: 'file', status: 'working' },
        { id: 'a2', name: 'wavepulse-opus-file', mode: 'file', status: 'idle' },
        { id: 'a3', name: 'grok-bot', mode: 'spawned', status: 'idle' },
      ],
      tasks: [
        {
          id: 'task-1',
          agent_id: 'a1',
          status: 'running',
          latest_run: {
            id: 'run-1',
            task_id: 'task-1',
            agent_id: 'a1',
            started_at: START,
            phase: 'running',
            last_line: 'waiting for tests',
            result_last_line: null,
          },
        },
        {
          id: 'task-tmux',
          agent_id: 'a3',
          status: 'running',
          latest_run: { id: 'run-tmux', task_id: 'task-tmux', agent_id: 'a3', started_at: START },
        },
      ],
    });

    expect(snapshot.seats).toEqual([
      { name: 'wavepulse-fable-file', status: 'working' },
      { name: 'wavepulse-opus-file', status: 'idle' },
    ]);
    expect(snapshot.running).toEqual([
      { id: 'task-1', agent: 'wavepulse-fable-file', run_id: 'run-1', phase: 'running', started_at: START },
    ]);
    expect(snapshot.runs[0].result_last_line).toBeNull();
    expect(snapshot.runs[0].last_line).toBe('waiting for tests');
  });

  it('prefers GET /api/runs presentFileRun fields when provided', () => {
    const snapshot = buildFileRunnerSnapshot({
      agents: [{ id: 'a1', name: 'wavepulse-opus-file', mode: 'file', status: 'idle' }],
      tasks: [{
        id: 'task-2',
        agent_id: 'a1',
        status: 'done',
        run_phase: 'done',
        latest_run: {
          id: 'run-2',
          task_id: 'task-2',
          agent_id: 'a1',
          started_at: START,
          phase: 'done',
          result_last_line: null,
        },
      }],
      runs: {
        'run-2': {
          id: 'run-2',
          task_id: 'task-2',
          agent_id: 'a1',
          started_at: START,
          phase: 'incomplete',
          last_line: 'claude exited 0',
          result_last_line: null,
        },
      },
    });

    expect(snapshot.runs).toEqual([{
      run_id: 'run-2',
      task_id: 'task-2',
      agent: 'wavepulse-opus-file',
      phase: 'incomplete',
      last_line: 'claude exited 0',
      result_last_line: null,
      started_at: START,
    }]);
  });
});

describe('fetchFileRunnerSnapshot', () => {
  it('reads GET /api/tasks and GET /api/runs/:id (no tmux)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/agents')) {
        return new Response(JSON.stringify([
          { id: 'a1', name: 'wavepulse-fable-file', mode: 'file', status: 'working' },
        ]), { status: 200 });
      }
      if (url.endsWith('/api/tasks')) {
        return new Response(JSON.stringify([{
          id: 'task-1',
          agent_id: 'a1',
          status: 'running',
          latest_run: {
            id: 'run-1',
            task_id: 'task-1',
            agent_id: 'a1',
            started_at: START,
            phase: 'running',
            last_line: 'compiling',
            result_last_line: null,
          },
        }]), { status: 200 });
      }
      if (url.endsWith('/api/runs/run-1')) {
        return new Response(JSON.stringify({
          id: 'run-1',
          task_id: 'task-1',
          agent_id: 'a1',
          started_at: START,
          phase: 'running',
          last_line: 'waiting for tests',
          result_last_line: null,
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await fetchFileRunnerSnapshot({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveConnection: () => ({ url: 'http://127.0.0.1:3777', token: 'test-token' }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.runs[0].last_line).toBe('waiting for tests');
    expect(result.data.seats).toEqual([{ name: 'wavepulse-fable-file', status: 'working' }]);
    expect(fetchImpl.mock.calls.map((call) => String(call[0])).sort()).toEqual([
      'http://127.0.0.1:3777/api/agents',
      'http://127.0.0.1:3777/api/runs/run-1',
      'http://127.0.0.1:3777/api/tasks',
    ]);
  });
});

describe('runFileRunnerStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-status-cli-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints snapshot JSON and stays silent on --notify-if-changed with no change', async () => {
    const payload = {
      agents: [{ id: 'a1', name: 'wavepulse-opus-file', mode: 'file', status: 'idle' }],
      tasks: [] as unknown[],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/agents')) return new Response(JSON.stringify(payload.agents), { status: 200 });
      if (String(url).endsWith('/api/tasks')) return new Response(JSON.stringify(payload.tasks), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    const chunks: string[] = [];
    const stdout = { write(chunk: string) { chunks.push(chunk); } };
    const stampPath = path.join(tmpDir, 'status-stamp.json');
    const conn = { url: 'http://127.0.0.1:3777', token: 'test-token' };

    const printed = await runFileRunnerStatus({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveConnection: () => conn,
      stdout,
    });
    expect(printed).toEqual({ ok: true });
    expect(chunks.join('')).toContain('"wavepulse-opus-file"');

    chunks.length = 0;
    const firstStamp = await runFileRunnerStatus({
      notifyIfChanged: true,
      stampPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveConnection: () => conn,
      stdout,
      notifyFn: vi.fn(async () => undefined),
    });
    expect(firstStamp).toEqual({ ok: true });
    expect(chunks.join('')).toBe('');

    chunks.length = 0;
    const again = await runFileRunnerStatus({
      notifyIfChanged: true,
      stampPath,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveConnection: () => conn,
      stdout,
      notifyFn: vi.fn(async () => undefined),
    });
    expect(again).toEqual({ ok: true });
    expect(chunks.join('')).toBe('');
  });
});
