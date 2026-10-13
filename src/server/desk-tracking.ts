/**
 * Product Desk linkage for the overview snapshot.
 * Reads tasks, runs, reviews, and freezes. Never writes to the desk.
 *
 * A run, a review, and a freeze inherit the desk numbers named on the task.
 * A freeze note or branch also counts: `Desk #84` and `desk84-s6`.
 */

import fs from 'node:fs';
import { getDb } from './db.js';

export const DESK_IDLE_MS = 24 * 60 * 60 * 1000;

export type DeskFlag = 'idle_24h' | 'two_builders' | 'unreviewed' | 'suggest_close';

export interface DeskTrackingRow {
  id: number;
  status: string;
  title: string;
  updated_at: string | null;
  builders: string[];
  flags: DeskFlag[];
  note: string;
}

export interface DeskLinkTask {
  id: string;
  num: number | null;
  status: string;
  agent_id: string | null;
  agent_name: string | null;
}

export interface DeskLinkLane {
  sha: string;
  verdict: string | null;
  status: string;
  lane: string | null;
  author: string | null;
}

export interface DeskLinkRun {
  id: string;
  status: string;
  review_status: string;
  agent_name: string | null;
}

export interface DeskLinkReview {
  run_id: string;
  status: string;
  verdict: string | null;
}

export interface DeskLinks {
  lanes: DeskLinkLane[];
  tasks: DeskLinkTask[];
  runs: DeskLinkRun[];
  reviews: DeskLinkReview[];
}

interface TaskRow {
  id: string;
  num: number | null;
  status: string;
  agent_id: string | null;
  agent_name: string | null;
  prompt: string;
  created_at: string;
  desks: number[];
}

interface RunRow {
  id: string;
  task_id: string;
  status: string;
  review_status: string;
  agent_id: string;
  agent_name: string | null;
  started_at: string;
  finished_at: string | null;
  desks: number[];
}

interface ReviewRow {
  run_id: string;
  status: string;
  verdict: string | null;
  desks: number[];
}

interface FreezeRow {
  sha: string;
  status: string;
  verdict: string | null;
  lane: string | null;
  author: string | null;
  agent_id: string | null;
  updated_at: string | null;
  desks: number[];
  deployed: boolean;
  slice: string | null;
}

export interface DeskWork {
  tasks: TaskRow[];
  runs: RunRow[];
  reviews: ReviewRow[];
  freezes: FreezeRow[];
}

export interface DeskAgent {
  id: string;
  name: string;
  status: string;
  for_min: number | null;
}

/** Desk numbers named in a prompt, freeze note, or branch (`Desk #84`, `PD-108`, `desk84-s6`). */
export function deskIdsIn(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(/\b(?:desk|pd)[\s#_-]*(\d{1,6})\b/gi)) {
    const id = Number(match[1]);
    if (Number.isInteger(id)) found.add(id);
  }
  return [...found];
}

/** `desk84-s6` → `s6`. A request without this suffix is not split. */
export function deskSlice(text: string, id: number): string | null {
  const re = new RegExp(`(?:^|[^\\w])(?:desk|pd)[\\s#_-]*${id}-s(\\d+)\\b`, 'i');
  const match = re.exec(text);
  return match?.[1] ? `s${match[1]}` : null;
}

function iso(sqlite: string | null | undefined): number | null {
  if (!sqlite) return null;
  const value = sqlite.includes('T') ? sqlite : `${sqlite.replace(' ', 'T')}Z`;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function query<T>(sql: string, ...params: unknown[]): T[] {
  try {
    return getDb().prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function noteText(filePath: string | null): string {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, 4000);
  } catch {
    return '';
  }
}

/** One pass over tasks, the runs and reviews that inherit them, and freezes. */
export function loadDeskWork(): DeskWork {
  const tasks = query<{
    id: string; num: number | null; status: string; agent_id: string | null; agent_name: string | null; prompt: string; created_at: string;
  }>(
    `SELECT t.id, t.num, t.status, t.agent_id, t.prompt, t.created_at, a.name AS agent_name
     FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
     WHERE t.prompt LIKE '%desk%' OR t.prompt LIKE '%PD-%' OR t.prompt LIKE '%pd-%'
     ORDER BY t.created_at DESC LIMIT 500`,
  ).map((row) => ({ ...row, desks: deskIdsIn(row.prompt) })).filter((row) => row.desks.length > 0);

  const desksByTask = new Map(tasks.map((row) => [row.id, row.desks]));
  const runs = query<{
    id: string; task_id: string; status: string; review_status: string; agent_id: string; agent_name: string | null; started_at: string; finished_at: string | null;
  }>(
    `SELECT r.id, r.task_id, r.status, r.review_status, r.agent_id, r.started_at, r.finished_at, a.name AS agent_name
     FROM runs r JOIN tasks t ON t.id = r.task_id LEFT JOIN agents a ON a.id = r.agent_id
     WHERE t.prompt LIKE '%desk%' OR t.prompt LIKE '%PD-%' OR t.prompt LIKE '%pd-%'`,
  ).map((row) => ({ ...row, desks: desksByTask.get(row.task_id) ?? deskIdsIn('') })).filter((row) => row.desks.length > 0);

  const desksByRun = new Map(runs.map((row) => [row.id, row.desks]));
  const reviews = query<{ run_id: string; status: string; verdict: string | null }>(
    `SELECT c.run_id, c.status, c.verdict FROM code_reviews c
     JOIN runs r ON r.id = c.run_id JOIN tasks t ON t.id = r.task_id
     WHERE t.prompt LIKE '%desk%' OR t.prompt LIKE '%PD-%' OR t.prompt LIKE '%pd-%'`,
  ).map((row) => ({ ...row, desks: desksByRun.get(row.run_id) ?? [] })).filter((row) => row.desks.length > 0);

  const deployed = new Set(query<{ sha: string }>(
    `SELECT DISTINCT lower(COALESCE(deployed_sha, sha)) AS sha FROM release_requests WHERE status = 'deployed'`,
  ).map((row) => row.sha));

  const freezeRows = query<{
    sha: string; desk: number | null; lane: string | null; run_id: string | null; verdict: string | null; status: string;
    freeze_path: string | null; updated_at: string | null; author_name: string | null; author_agent_id: string | null;
  }>(
    `SELECT sha, desk, lane, run_id, verdict, status, freeze_path, updated_at, author_name, author_agent_id FROM release_freezes`,
  );
  const freezes: FreezeRow[] = [];
  let notesRead = 0;
  for (const row of freezeRows) {
    const desks = new Set<number>();
    if (row.desk != null) desks.add(row.desk);
    const laneText = row.lane ?? '';
    for (const id of deskIdsIn(laneText)) desks.add(id);
    if (row.run_id) for (const id of desksByRun.get(row.run_id) ?? []) desks.add(id);
    if (desks.size === 0 && row.freeze_path && notesRead < 40) {
      notesRead += 1;
      for (const id of deskIdsIn(noteText(row.freeze_path))) desks.add(id);
    }
    if (desks.size === 0) continue;
    const slice = [...desks].map((id) => deskSlice(laneText, id)).find((value) => value) ?? null;
    freezes.push({
      sha: row.sha,
      status: row.status,
      verdict: row.verdict,
      lane: row.lane,
      author: row.author_name,
      agent_id: row.author_agent_id,
      updated_at: row.updated_at,
      desks: [...desks],
      deployed: deployed.has(row.sha.toLowerCase()),
      slice,
    });
  }
  return { tasks, runs, reviews, freezes };
}

export function linksFromIndex(work: DeskWork, id: number): DeskLinks {
  return {
    lanes: work.freezes.filter((row) => row.desks.includes(id)).map((row) => ({
      sha: row.sha, verdict: row.verdict, status: row.status, lane: row.lane, author: row.author,
    })),
    tasks: work.tasks.filter((row) => row.desks.includes(id)).map(({ prompt: _prompt, created_at: _at, desks: _desks, ...row }) => {
      void _prompt; void _at; void _desks;
      return row;
    }),
    runs: work.runs.filter((row) => row.desks.includes(id)).map((row) => ({
      id: row.id, status: row.status, review_status: row.review_status, agent_name: row.agent_name,
    })),
    reviews: work.reviews.filter((row) => row.desks.includes(id)).map(({ desks: _desks, ...row }) => {
      void _desks;
      return row;
    }),
  };
}

interface OpenDesk {
  id: number;
  status: string;
  title: string;
  updated_at: string | null;
}

function has(desks: number[], id: number): boolean {
  return desks.includes(id);
}

/**
 * In-progress desk requests, with the flags the overview should show.
 * `suggest_close` is advice only — nothing here writes to Product Desk.
 */
export function trackOpenDesks(items: OpenDesk[], work: DeskWork, agents: DeskAgent[], now: number): DeskTrackingRow[] {
  const byAgent = new Map(agents.map((agent) => [agent.id, agent]));
  const rows: DeskTrackingRow[] = [];
  for (const item of items) {
    const tasks = work.tasks.filter((row) => has(row.desks, item.id));
    const runs = work.runs.filter((row) => has(row.desks, item.id));
    const freezes = work.freezes.filter((row) => has(row.desks, item.id));
    const builders = new Map<string, { id: string | null; name: string; slices: Set<string>; open: boolean }>();
    const add = (agentId: string | null, name: string | null, text: string, open: boolean) => {
      const key = agentId ?? (name ? `name:${name}` : null);
      if (!key) return;
      const current = builders.get(key) ?? { id: agentId, name: name ?? key, slices: new Set<string>(), open: false };
      const slice = deskSlice(text, item.id);
      if (slice) current.slices.add(slice);
      current.open = current.open || open;
      builders.set(key, current);
    };
    for (const task of tasks) add(task.agent_id, task.agent_name, task.prompt, task.status === 'pending' || task.status === 'running');
    for (const run of runs) add(run.agent_id, run.agent_name, '', run.status === 'running');
    for (const freeze of freezes) {
      add(freeze.agent_id, freeze.author, freeze.lane ?? '', freeze.status === 'open' || freeze.status === 'behind-main');
    }
    const seat = (builder: { id: string | null; name: string }) => (builder.id ? byAgent.get(builder.id) : undefined) ?? [...byAgent.values()].find((agent) => agent.name === builder.name);

    const flags: DeskFlag[] = [];
    const openBuilders = [...builders.values()].filter((builder) => builder.open);
    const slices = openBuilders.map((builder) => (builder.slices.size === 1 ? [...builder.slices][0] : null));
    const split = openBuilders.length >= 2 && slices.every((slice) => !!slice) && new Set(slices).size === openBuilders.length;
    if (openBuilders.length >= 2 && !split) flags.push('two_builders');

    const unreviewedRun = runs.some((run) => run.status === 'done' && run.review_status === 'pending');
    const unreviewedFreeze = freezes.some((freeze) => (freeze.status === 'open' || freeze.status === 'behind-main') && !freeze.verdict);
    if (unreviewedRun || unreviewedFreeze) flags.push('unreviewed');

    const times = [
      ...tasks.map((task) => iso(task.created_at)),
      ...runs.map((run) => iso(run.finished_at) ?? iso(run.started_at)),
      ...freezes.map((freeze) => iso(freeze.updated_at)),
    ].filter((value): value is number => value != null);
    const latest = times.length ? Math.max(...times) : null;
    const someoneWorking = [...builders.values()].some((builder) => seat(builder)?.status === 'working');
    const idleSeat = openBuilders.some((builder) => {
      const agent = seat(builder);
      return !!agent && agent.status === 'idle' && (agent.for_min ?? 0) >= DESK_IDLE_MS / 60_000;
    });
    const stale = latest != null && now - latest >= DESK_IDLE_MS && !someoneWorking && openBuilders.length > 0;
    if (idleSeat || stale) flags.push('idle_24h');

    const openTask = tasks.some((task) => task.status === 'pending' || task.status === 'running' || task.status === 'blocked');
    const openRun = runs.some((run) => run.status === 'running');
    const pendingReview = runs.some((run) => run.status === 'done' && run.review_status === 'pending');
    const liveFreeze = (freeze: FreezeRow) => freeze.status === 'merged' || freeze.deployed;
    const implementing = item.status.toLowerCase() === 'implementing';
    if (implementing && freezes.length > 0 && freezes.every(liveFreeze) && !openTask && !openRun && !pendingReview) {
      flags.push('suggest_close');
    }

    const names = [...builders.values()].map((builder) => builder.name);
    const notes: string[] = [];
    if (flags.includes('idle_24h')) notes.push('idle more than 24 h');
    if (flags.includes('two_builders')) notes.push(`${openBuilders.map((builder) => builder.name).join(' and ')} are both on this request without a split`);
    if (flags.includes('unreviewed')) notes.push('work is done and still unreviewed');
    if (flags.includes('suggest_close')) notes.push('all linked work is live — still implementing; suggest closing');
    rows.push({
      id: item.id,
      status: item.status,
      title: item.title,
      updated_at: item.updated_at,
      builders: names,
      flags,
      note: notes.join('; '),
    });
  }
  return rows;
}
