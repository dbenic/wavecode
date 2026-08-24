/**
 * Local file-runner status for the daemon host.
 *
 * `wavecode status` talks to the localhost HTTP API (same token as
 * `wavecode queue`) and prints a compact JSON snapshot. It does not
 * scrape tmux. result.txt last line (RESULT: PASS|FAIL) is the source
 * of truth when present; missing is reported as null — this module
 * never invents RESULT: FAIL.
 *
 * `--notify-if-changed` compares against a stamp under the WaveCode
 * data dir and stays silent when nothing material changed, so a 1-min
 * cron can replace an LLM poll. Material changes: a RESULT last line
 * appearing, phase done|failed|incomplete, or in-flight with no
 * result.txt for 40 minutes (STALE).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WaveCodeApiError, WaveCodeClient } from '../mcp/client.js';
import { getConfig } from '../server/config.js';
import { notify } from '../server/notifications.js';
import { writeLine } from './stdio-guard.js';
import { resolveDaemonConnection } from './daemon-connection.js';

export const STATUS_STAMP_FILE = 'status-stamp.json';
export const STALE_AFTER_MS = 40 * 60 * 1000;
export const FILE_RUNNER_SEAT_NAMES = ['wavepulse-fable-file', 'wavepulse-opus-file'] as const;
export const IN_FLIGHT_PHASES = ['queued', 'starting', 'running'] as const;
export const TERMINAL_PHASES = ['done', 'failed', 'incomplete'] as const;

const RESULT_LINE = /^RESULT: (PASS|FAIL)$/;

export interface FileRunnerSeat {
  name: string;
  status: 'idle' | 'working' | 'error';
}

export interface FileRunnerRunningTask {
  id: string;
  agent: string;
  run_id: string;
  phase: string | null;
  started_at: string;
}

export interface FileRunnerRunRow {
  run_id: string;
  task_id: string;
  agent: string;
  phase: string | null;
  last_line: string | null;
  /** Exact `RESULT: PASS` / `RESULT: FAIL` from result.txt, else null (missing). */
  result_last_line: string | null;
  started_at: string;
}

export interface FileRunnerStatusSnapshot {
  running: FileRunnerRunningTask[];
  runs: FileRunnerRunRow[];
  seats: FileRunnerSeat[];
}

export type StatusChangeKind = 'RESULT' | 'phase' | 'STALE';

export interface StatusChangeEvent {
  kind: StatusChangeKind;
  run_id: string;
  task_id: string;
  agent: string;
  phase: string | null;
  result_last_line: string | null;
  started_at: string;
}

export interface StatusStamp {
  signals: StatusSignal[];
  snapshot: FileRunnerStatusSnapshot;
}

export interface StatusSignal {
  run_id: string;
  phase: string | null;
  result_last_line: string | null;
  stale: boolean;
}

export interface ApiAgent {
  id: string;
  name: string;
  mode?: string;
  status?: 'idle' | 'working' | 'error';
}

export interface ApiPresentedRun {
  id?: string;
  task_id?: string;
  agent_id?: string;
  started_at?: string;
  finished_at?: string | null;
  phase?: string | null;
  last_line?: string | null;
  result?: 'PASS' | 'FAIL' | null;
  result_last_line?: string | null;
  result_path?: string | null;
}

export interface ApiTask {
  id: string;
  agent_id?: string | null;
  status?: string;
  created_at?: string;
  run_phase?: string | null;
  result?: string | null;
  latest_run?: ApiPresentedRun | null;
}

export interface StatusCommandOpts {
  notifyIfChanged?: boolean;
  watch?: boolean;
  intervalSec?: number;
  stampPath?: string;
  nowMs?: number;
  stdout?: { write(chunk: string): unknown };
  fetchImpl?: typeof fetch;
  resolveConnection?: () => { url: string; token: string | null };
  notifyFn?: typeof notify;
  sleepFn?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso);
  const ms = Date.parse(hasZone ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

export function parseableResultLastLine(value: string | null | undefined): string | null {
  const line = value?.trim() ?? '';
  return RESULT_LINE.test(line) ? line : null;
}

export function isFileRunnerSeat(agent: ApiAgent): boolean {
  return agent.mode === 'file' || FILE_RUNNER_SEAT_NAMES.includes(agent.name as typeof FILE_RUNNER_SEAT_NAMES[number]);
}

export function isInFlightPhase(phase: string | null | undefined): boolean {
  return phase != null && (IN_FLIGHT_PHASES as readonly string[]).includes(phase);
}

export function isTerminalPhase(phase: string | null | undefined): boolean {
  return phase != null && (TERMINAL_PHASES as readonly string[]).includes(phase);
}

export function isStaleRun(run: Pick<FileRunnerRunRow, 'phase' | 'result_last_line' | 'started_at'>, nowMs: number): boolean {
  if (parseableResultLastLine(run.result_last_line)) return false;
  if (isTerminalPhase(run.phase)) return false;
  if (run.phase && !isInFlightPhase(run.phase)) return false;
  const started = parseTimestamp(run.started_at);
  if (!Number.isFinite(started)) return false;
  return nowMs - started >= STALE_AFTER_MS;
}

export function resolveDataDir(): string {
  try {
    const transcripts = getConfig().paths.transcripts_root;
    if (transcripts?.trim()) return path.dirname(transcripts);
  } catch {
    // config not loaded
  }
  return path.join(os.homedir(), '.wavecode-data');
}

export function defaultStampPath(): string {
  return path.join(resolveDataDir(), STATUS_STAMP_FILE);
}

export function snapshotSignals(snapshot: FileRunnerStatusSnapshot, nowMs: number): StatusSignal[] {
  return snapshot.runs
    .map((run) => ({
      run_id: run.run_id,
      phase: run.phase,
      result_last_line: parseableResultLastLine(run.result_last_line),
      stale: isStaleRun(run, nowMs),
    }))
    .sort((a, b) => a.run_id.localeCompare(b.run_id));
}

export function readStatusStamp(stampPath: string): StatusStamp | null {
  try {
    const raw = fs.readFileSync(stampPath, 'utf8');
    const parsed = JSON.parse(raw) as StatusStamp;
    if (!parsed || !Array.isArray(parsed.signals) || !parsed.snapshot) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStatusStamp(stampPath: string, snapshot: FileRunnerStatusSnapshot, nowMs: number): void {
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  const stamp: StatusStamp = {
    signals: snapshotSignals(snapshot, nowMs),
    snapshot,
  };
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}

export function formatStatusEventLine(event: StatusChangeEvent): string {
  if (event.kind === 'RESULT') {
    return `RESULT ${event.run_id} ${event.result_last_line ?? 'missing'}`;
  }
  if (event.kind === 'STALE') {
    return `STALE ${event.run_id} running no result.txt`;
  }
  return `phase ${event.run_id} ${event.phase ?? 'unknown'}`;
}

export function diffFileRunnerStatus(
  prev: StatusStamp | null,
  current: FileRunnerStatusSnapshot,
  nowMs: number,
): StatusChangeEvent[] {
  if (!prev) return [];

  const prevById = new Map(prev.signals.map((signal) => [signal.run_id, signal]));
  const events: StatusChangeEvent[] = [];

  for (const run of current.runs) {
    const previous = prevById.get(run.run_id);
    const resultLine = parseableResultLastLine(run.result_last_line);
    const stale = isStaleRun(run, nowMs);

    if (resultLine && resultLine !== previous?.result_last_line) {
      events.push({
        kind: 'RESULT',
        run_id: run.run_id,
        task_id: run.task_id,
        agent: run.agent,
        phase: run.phase,
        result_last_line: resultLine,
        started_at: run.started_at,
      });
    }

    if (isTerminalPhase(run.phase) && run.phase !== previous?.phase) {
      events.push({
        kind: 'phase',
        run_id: run.run_id,
        task_id: run.task_id,
        agent: run.agent,
        phase: run.phase,
        result_last_line: resultLine,
        started_at: run.started_at,
      });
    }

    if (stale && !previous?.stale) {
      events.push({
        kind: 'STALE',
        run_id: run.run_id,
        task_id: run.task_id,
        agent: run.agent,
        phase: run.phase,
        result_last_line: resultLine,
        started_at: run.started_at,
      });
    }
  }

  return events;
}

/**
 * Compare snapshot to the stamp file. Always writes the new stamp.
 * Returns `output: null` when there is no material change (including
 * the first run, which only establishes the baseline).
 */
export function notifyIfChanged(
  stampPath: string,
  snapshot: FileRunnerStatusSnapshot,
  nowMs: number,
): { output: string | null; events: StatusChangeEvent[] } {
  const prev = readStatusStamp(stampPath);
  const events = diffFileRunnerStatus(prev, snapshot, nowMs);
  writeStatusStamp(stampPath, snapshot, nowMs);
  if (events.length === 0) return { output: null, events };
  return { output: `${JSON.stringify({ events })}\n`, events };
}

export function buildFileRunnerSnapshot(input: {
  agents: ApiAgent[];
  tasks: ApiTask[];
  runs?: Record<string, ApiPresentedRun>;
}): FileRunnerStatusSnapshot {
  const fileSeats = input.agents.filter(isFileRunnerSeat);
  const seatsById = new Map(fileSeats.map((agent) => [agent.id, agent]));
  const nameById = new Map(input.agents.map((agent) => [agent.id, agent.name]));

  const selected = new Map<string, FileRunnerRunRow>();
  const finishedBySeat = new Map<string, FileRunnerRunRow>();

  for (const task of input.tasks) {
    if (!task.agent_id || !seatsById.has(task.agent_id)) continue;
    const fetched = task.latest_run?.id ? input.runs?.[task.latest_run.id] : undefined;
    const row = presentTaskRun(task, fetched, nameById);
    if (!row) continue;

    const inFlight = task.status === 'running' || isInFlightPhase(row.phase);
    if (inFlight) {
      selected.set(row.run_id, row);
      continue;
    }

    if (!isTerminalPhase(row.phase)) continue;
    const existing = finishedBySeat.get(task.agent_id);
    if (!existing || parseTimestamp(row.started_at) >= parseTimestamp(existing.started_at)) {
      finishedBySeat.set(task.agent_id, row);
    }
  }

  for (const row of finishedBySeat.values()) {
    if (!selected.has(row.run_id)) selected.set(row.run_id, row);
  }

  const runs = [...selected.values()].sort((a, b) => a.run_id.localeCompare(b.run_id));
  const running = input.tasks
    .filter((task) => task.status === 'running' && task.agent_id && seatsById.has(task.agent_id) && task.latest_run?.id)
    .map((task) => {
      const row = selected.get(task.latest_run!.id!) ?? presentTaskRun(task, input.runs?.[task.latest_run!.id!], nameById);
      return {
        id: task.id,
        agent: row?.agent ?? nameById.get(task.agent_id!) ?? task.agent_id!,
        run_id: task.latest_run!.id!,
        phase: row?.phase ?? task.latest_run?.phase ?? task.run_phase ?? null,
        started_at: row?.started_at ?? task.latest_run?.started_at ?? task.created_at ?? '',
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const seats = fileSeats
    .map((agent) => ({
      name: agent.name,
      status: agent.status ?? 'idle',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { running, runs, seats };
}

function presentTaskRun(
  task: ApiTask,
  fetched: ApiPresentedRun | undefined,
  nameById: Map<string, string>,
): FileRunnerRunRow | null {
  const latest = task.latest_run;
  const id = fetched?.id ?? latest?.id;
  if (!id) return null;
  const agentId = fetched?.agent_id ?? latest?.agent_id ?? task.agent_id ?? '';
  return {
    run_id: id,
    task_id: fetched?.task_id ?? latest?.task_id ?? task.id,
    agent: nameById.get(agentId) ?? agentId,
    phase: fetched?.phase ?? latest?.phase ?? task.run_phase ?? null,
    last_line: fetched?.last_line ?? latest?.last_line ?? null,
    result_last_line: parseableResultLastLine(fetched?.result_last_line ?? latest?.result_last_line),
    started_at: fetched?.started_at ?? latest?.started_at ?? task.created_at ?? '',
  };
}

export async function fetchFileRunnerSnapshot(deps: {
  fetchImpl?: typeof fetch;
  resolveConnection?: () => { url: string; token: string | null };
  client?: WaveCodeClient;
} = {}): Promise<{ ok: true; data: FileRunnerStatusSnapshot } | { ok: false; error: string }> {
  const conn = (deps.resolveConnection ?? resolveDaemonConnection)();
  const client = deps.client ?? new WaveCodeClient({
    baseUrl: conn.url,
    token: conn.token,
    fetchImpl: deps.fetchImpl,
  });

  try {
    const [agents, tasks] = await Promise.all([
      client.get<ApiAgent[]>('/agents'),
      client.get<ApiTask[]>('/tasks'),
    ]);

    const draft = buildFileRunnerSnapshot({ agents, tasks });
    const runs: Record<string, ApiPresentedRun> = {};
    await Promise.all(draft.runs.map(async (row) => {
      try {
        runs[row.run_id] = await client.get<ApiPresentedRun>(`/runs/${row.run_id}`);
      } catch {
        // latest_run from GET /api/tasks already has presentFileRun fields
      }
    }));

    return { ok: true, data: buildFileRunnerSnapshot({ agents, tasks, runs }) };
  } catch (err) {
    if (err instanceof WaveCodeApiError) return { ok: false, error: err.message };
    const message = err instanceof Error ? err.message : 'Daemon is not reachable';
    return { ok: false, error: message };
  }
}

export async function runFileRunnerStatus(opts: StatusCommandOpts = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const stdout = opts.stdout ?? process.stdout;
  const stampPath = opts.stampPath ?? defaultStampPath();
  const intervalMs = Math.max(1, opts.intervalSec ?? 60) * 1000;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const notifyFn = opts.notifyFn ?? notify;
  const watch = Boolean(opts.watch);
  const notifyMode = watch || Boolean(opts.notifyIfChanged);

  const once = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const fetched = await fetchFileRunnerSnapshot({
      fetchImpl: opts.fetchImpl,
      resolveConnection: opts.resolveConnection,
    });
    if (!fetched.ok) return fetched;

    const nowMs = opts.nowMs ?? Date.now();
    if (!notifyMode) {
      writeLine(stdout, JSON.stringify(fetched.data, null, 2));
      return { ok: true };
    }

    const { output, events } = notifyIfChanged(stampPath, fetched.data, nowMs);
    if (output) {
      writeLine(stdout, output.trimEnd());
      const body = events.map(formatStatusEventLine).join(' | ');
      try {
        await notifyFn({
          title: 'WaveCode file-runner',
          body,
          url: '/tasks',
          tag: 'file-runner-status',
        });
      } catch {
        // already-wired ntfy/Telegram/web-push only; never fail the CLI
      }
    }
    return { ok: true };
  };

  if (!watch) return once();

  while (!opts.signal?.aborted) {
    const result = await once();
    void result;
    if (opts.signal?.aborted) break;
    await sleep(intervalMs);
  }
  return { ok: true };
}
