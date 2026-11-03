import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ getConfig: vi.fn() }));
vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./proc.js', () => ({ execFileAsync: vi.fn() }));
vi.mock('./tmux.js', () => ({ tmuxExecSafe: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import * as config from './config.js';
import * as eventBus from './event-bus.js';
import type { Agent } from './db.js';
import {
  attributeToPanes, parsePs, resetRunawayState, sweepRunawayProcesses, type ProcSample, type RunawayDeps,
} from './runaway-processes.js';

const MIN = 60_000;

function agent(name: string, status: Agent['status'] = 'idle'): Agent {
  return {
    id: `id-${name}`, name, runtime: 'codex', tmux_session: `wc-${name}`, workspace: null, mode: 'spawned', status,
    owner_id: null, lease_expires_at: null, lease_reason: null, profile: null, role: null, alias: null, persona: null,
    created_at: '2026-11-03 00:00:00',
  } as Agent;
}

/** pane shell 100 → codex 200 → serena 300; an unrelated process 900. */
function procs(serenaCpu: number, codexCpu = 5): ProcSample[] {
  return [
    { pid: 100, ppid: 1, cpuSeconds: 1, comm: 'bash' },
    { pid: 200, ppid: 100, cpuSeconds: codexCpu, comm: 'codex' },
    { pid: 300, ppid: 200, cpuSeconds: serenaCpu, comm: 'python' },
    { pid: 900, ppid: 1, cpuSeconds: 99_999, comm: 'tailscaled' },
  ];
}

function deps(list: () => ProcSample[]): RunawayDeps {
  return {
    listProcs: async () => list(),
    listPanePids: async () => new Map([[100, 'wc-codex2']]),
  };
}

describe('runaway-processes.ts', () => {
  beforeEach(() => {
    resetRunawayState();
    vi.mocked(config.getConfig).mockReturnValue({ autonomy: { runaway_cpu_min: 10 } } as never);
    vi.mocked(eventBus.emit).mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('parses ps output and drops lines that do not fit', () => {
    const out = '    1       0     1564 systemd\n 998284  998016  8077 python\n garbage\n\n';
    expect(parsePs(out)).toEqual([
      { pid: 1, ppid: 0, cpuSeconds: 1564, comm: 'systemd' },
      { pid: 998284, ppid: 998016, cpuSeconds: 8077, comm: 'python' },
    ]);
  });

  it('attributes descendants to their pane and leaves the pane shell and strangers out', () => {
    const owner = attributeToPanes(procs(0), new Map([[100, 'wc-codex2']]));
    expect(owner.get(200)).toBe('wc-codex2');
    expect(owner.get(300)).toBe('wc-codex2');
    expect(owner.has(100)).toBe(false);
    expect(owner.has(900)).toBe(false);
  });

  it('reports a process burning a core for the window under an idle agent, once', async () => {
    let cpu = 0;
    const d = deps(() => procs(cpu));
    const agents = [agent('codex2')];
    // 30 s ticks, serena at 100 % of a core: 30 cpu seconds per tick
    let now = 0;
    for (let tick = 0; tick < 21; tick++) {
      const reports = await sweepRunawayProcesses(agents, d, now);
      if (tick < 20) expect(reports).toEqual([]); // 10 min of hot stretch needs 20 rated ticks after the first sample
      else expect(reports).toHaveLength(1);
      cpu += 30; now += 30_000;
    }
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith('agent.runaway_process', 'agent', 'id-codex2', expect.objectContaining({
      name: 'codex2', pid: 300, comm: 'python', cores: 1, minutes: 10, action: 'report',
    }), null);
    // Still hot on the next ticks: no second report for the same stretch
    for (let tick = 0; tick < 4; tick++) { cpu += 30; now += 30_000; expect(await sweepRunawayProcesses(agents, d, now)).toEqual([]); }
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while the agent is working, and for a process that cools down', async () => {
    let cpu = 0; let now = 0;
    const d = deps(() => procs(cpu));
    const working = [agent('codex2', 'working')];
    for (let tick = 0; tick < 30; tick++) { await sweepRunawayProcesses(working, d, now); cpu += 30; now += 30_000; }
    expect(eventBus.emit).not.toHaveBeenCalled();

    resetRunawayState();
    cpu = 0; now = 0;
    const idle = [agent('codex2')];
    for (let tick = 0; tick < 12; tick++) { await sweepRunawayProcesses(idle, d, now); cpu += 30; now += 30_000; }
    // cools down for one tick, then hot again: the stretch restarts
    for (let tick = 0; tick < 2; tick++) { await sweepRunawayProcesses(idle, d, now); now += 30_000; }
    for (let tick = 0; tick < 12; tick++) { await sweepRunawayProcesses(idle, d, now); cpu += 30; now += 30_000; }
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('does nothing when runaway_cpu_min is 0', async () => {
    vi.mocked(config.getConfig).mockReturnValue({ autonomy: { runaway_cpu_min: 0 } } as never);
    const listProcs = vi.fn(async () => procs(0));
    const d: RunawayDeps = { listProcs, listPanePids: async () => new Map() };
    expect(await sweepRunawayProcesses([agent('codex2')], d, 0)).toEqual([]);
    expect(listProcs).not.toHaveBeenCalled();
  });

  it('turns itself off after the first failed process listing', async () => {
    const listProcs = vi.fn(async () => { throw new Error('ps: unknown format cputimes'); });
    const d: RunawayDeps = { listProcs, listPanePids: async () => new Map() };
    await sweepRunawayProcesses([agent('codex2')], d, 0);
    await sweepRunawayProcesses([agent('codex2')], d, 30_000);
    expect(listProcs).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('treats a reused pid (cpu went backwards or comm changed) as a new process', async () => {
    const samples: ProcSample[][] = [procs(1000), procs(1030), procs(5)];
    let i = 0;
    const d = deps(() => samples[Math.min(i++, samples.length - 1)]);
    const idle = [agent('codex2')];
    await sweepRunawayProcesses(idle, d, 0);
    await sweepRunawayProcesses(idle, d, 30_000);
    await sweepRunawayProcesses(idle, d, 60_000); // reset: no rate, no report ever from a 1-tick stretch
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
