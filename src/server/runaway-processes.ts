/**
 * Runaway helper processes under an idle pane (report only, 3 Nov 2026).
 *
 * A serena MCP server under codex2's pane burned a full core for 2 h 15 min
 * while the seat sat idle. Nothing in WaveCode noticed: the pane was quiet, so
 * hang detection had nothing to say, and the daemon's own CPU was fine.
 *
 * Each health tick samples cumulative CPU time of every process once (`ps`),
 * attributes each process to the pane it descends from, and rates it against
 * the previous tick. A process that burns at least RUNAWAY_CORES of a core for
 * `autonomy.runaway_cpu_min` minutes while its agent is not working gets one
 * `agent.runaway_process` event and a warning. Nothing is killed: a long
 * build under a working pane is normal, and killing a seat's helper is a
 * person's call.
 */
import type { Agent } from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import { execFileAsync } from './proc.js';
import * as tmux from './tmux.js';
import logger from './logger.js';

/** A process must average at least this many cores over the window to count. */
export const RUNAWAY_CORES = 0.8;
/** Default `autonomy.runaway_cpu_min`. 0 turns the sweep off. */
export const DEFAULT_RUNAWAY_CPU_MIN = 10;

export interface ProcSample {
  pid: number;
  ppid: number;
  /** Cumulative CPU seconds (user + system). */
  cpuSeconds: number;
  comm: string;
}

export interface RunawayDeps {
  listProcs(): Promise<ProcSample[]>;
  /** pane pid → tmux session name, every pane on the server. */
  listPanePids(): Promise<Map<number, string>>;
}

export interface RunawayReport {
  agent: Agent;
  pid: number;
  comm: string;
  cores: number;
  minutes: number;
}

interface TrackedProc {
  comm: string;
  cpuSeconds: number;
  sampledAt: number;
  /** When the current hot stretch began; null while below the threshold. */
  hotSince: number | null;
  reported: boolean;
}

const tracked = new Map<number, TrackedProc>();
/** Set when `ps` cannot be read here (a macOS dev run has no `cputimes`): the sweep turns itself off, once. */
let unavailable = false;

/** Parse `ps -eo pid,ppid,cputimes,comm --no-headers`. Lines that do not fit are dropped. */
export function parsePs(out: string): ProcSample[] {
  const procs: ProcSample[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds: Number(m[3]), comm: m[4].trim() });
  }
  return procs;
}

/** pid → the tmux session whose pane it descends from (the pane shell itself excluded). */
export function attributeToPanes(procs: ProcSample[], panePids: Map<number, string>): Map<number, string> {
  const parent = new Map<number, number>();
  for (const p of procs) parent.set(p.pid, p.ppid);
  const owner = new Map<number, string>();
  for (const p of procs) {
    if (panePids.has(p.pid)) continue;
    let cur = p.ppid;
    for (let hop = 0; hop < 32 && cur > 1; hop++) {
      const session = panePids.get(cur);
      if (session) { owner.set(p.pid, session); break; }
      const next = parent.get(cur);
      if (next === undefined) break;
      cur = next;
    }
  }
  return owner;
}

const defaultDeps: RunawayDeps = {
  async listProcs() {
    const out = await execFileAsync('ps', ['-eo', 'pid,ppid,cputimes,comm', '--no-headers'], { timeout: 5000 });
    return parsePs(out);
  },
  async listPanePids() {
    const out = await tmux.tmuxExecSafe(['list-panes', '-a', '-F', '#{session_name} #{pane_pid}']);
    const panes = new Map<number, string>();
    for (const line of (out ?? '').split('\n')) {
      const m = /^(\S+)\s+(\d+)$/.exec(line.trim());
      if (m) panes.set(Number(m[2]), m[1]);
    }
    return panes;
  },
};

/** Forget every sample (tests). */
export function resetRunawayState(): void {
  tracked.clear();
  unavailable = false;
}

/**
 * One sweep. Returns the reports it emitted this tick. The first sight of a
 * process only records it; a rate needs two samples.
 */
export async function sweepRunawayProcesses(agents: Agent[], deps: RunawayDeps = defaultDeps, now = Date.now()): Promise<RunawayReport[]> {
  const minutes = getConfig().autonomy.runaway_cpu_min ?? DEFAULT_RUNAWAY_CPU_MIN;
  if (!(minutes > 0)) return [];
  const windowMs = minutes * 60_000;
  if (unavailable) return [];

  let procs: ProcSample[];
  let panePids: Map<number, string>;
  try {
    [procs, panePids] = await Promise.all([deps.listProcs(), deps.listPanePids()]);
  } catch (e) {
    unavailable = true;
    logger.warn({ error: (e as Error).message }, 'Runaway process sweep off: process list unavailable on this host');
    return [];
  }
  const owner = attributeToPanes(procs, panePids);
  const bySession = new Map<string, Agent>();
  for (const a of agents) bySession.set(a.tmux_session, a);

  const seen = new Set<number>();
  const reports: RunawayReport[] = [];
  for (const p of procs) {
    const session = owner.get(p.pid);
    if (!session) continue;
    seen.add(p.pid);
    const prev = tracked.get(p.pid);
    if (!prev || prev.comm !== p.comm || p.cpuSeconds < prev.cpuSeconds) {
      // New process, or the pid was reused: no rate yet.
      tracked.set(p.pid, { comm: p.comm, cpuSeconds: p.cpuSeconds, sampledAt: now, hotSince: null, reported: false });
      continue;
    }
    const wallMs = now - prev.sampledAt;
    if (wallMs <= 0) continue;
    const cores = ((p.cpuSeconds - prev.cpuSeconds) * 1000) / wallMs;
    prev.cpuSeconds = p.cpuSeconds;
    prev.sampledAt = now;
    if (cores < RUNAWAY_CORES) {
      prev.hotSince = null;
      prev.reported = false;
      continue;
    }
    if (prev.hotSince === null) prev.hotSince = now - wallMs;
    const hotMs = now - prev.hotSince;
    const agent = bySession.get(session);
    if (prev.reported || hotMs < windowMs || !agent || agent.status === 'working') continue;

    prev.reported = true;
    const report = { agent, pid: p.pid, comm: p.comm, cores: Math.round(cores * 100) / 100, minutes: Math.floor(hotMs / 60_000) };
    reports.push(report);
    logger.warn({ agentId: agent.id, name: agent.name, pid: p.pid, comm: p.comm, cores: report.cores, minutes: report.minutes }, 'Runaway process under an idle pane — reporting, not killing');
    emit('agent.runaway_process', 'agent', agent.id, {
      name: agent.name,
      pid: p.pid,
      comm: p.comm,
      cores: report.cores,
      minutes: report.minutes,
      action: 'report',
    }, null);
  }
  for (const pid of tracked.keys()) if (!seen.has(pid)) tracked.delete(pid);
  return reports;
}
