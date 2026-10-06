import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projects: Record<string, { workspace_match: string; setup_command?: string; repo?: string }> = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ projects, paths: { worktrees_root: '/wt' } })),
}));
vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { emit } from './event-bus.js';
import { runWorkspaceSetup } from './runtime-launcher.js';
import { codeBriefLine } from './orchestrator.js';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-setup-')); for (const k of Object.keys(projects)) delete projects[k]; vi.clearAllMocks(); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const until = async (pred: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); };

describe('worktree setup_command', () => {
  it('runs the matching project\'s command in the worktree, logs it, and emits started/done', async () => {
    projects.wavepulse = { workspace_match: `${tmp}/*`, setup_command: 'echo deps-installed > installed.txt' };
    const ws = path.join(tmp, 'codex1'); fs.mkdirSync(ws);
    expect(runWorkspaceSetup(ws, 'a1')).toBe('echo deps-installed > installed.txt');
    await until(() => fs.existsSync(path.join(ws, 'installed.txt')) && vi.mocked(emit).mock.calls.some((c) => (c[3] as { status: string }).status === 'done'));
    expect(fs.readFileSync(path.join(ws, 'installed.txt'), 'utf8').trim()).toBe('deps-installed');
    expect(fs.readFileSync(path.join(ws, '.wavecode-setup.log'), 'utf8')).toContain('[wavecode-setup exit 0]');
    const statuses = vi.mocked(emit).mock.calls.filter((c) => c[0] === 'agent.workspace_setup').map((c) => (c[3] as { status: string }).status);
    expect(statuses).toEqual(['started', 'done']);
  });

  it('does nothing for workspaces outside any project or projects without a setup_command', () => {
    projects.other = { workspace_match: '/elsewhere/*', setup_command: 'exit 1' };
    projects.plain = { workspace_match: `${tmp}/*` };
    expect(runWorkspaceSetup(path.join(tmp, 'x'), 'a1')).toBeNull();
    expect(vi.mocked(emit)).not.toHaveBeenCalled();
  });

  it('a failing command emits failed with its exit code', async () => {
    projects.wavepulse = { workspace_match: `${tmp}/*`, setup_command: 'exit 3' };
    const ws = path.join(tmp, 'codex2'); fs.mkdirSync(ws);
    runWorkspaceSetup(ws, 'a2');
    await until(() => vi.mocked(emit).mock.calls.some((c) => (c[3] as { status: string }).status === 'failed'));
    const failed = vi.mocked(emit).mock.calls.find((c) => (c[3] as { status: string }).status === 'failed')?.[3] as { exit_code: number };
    expect(failed.exit_code).toBe(3);
  });
});

describe('codeBriefLine', () => {
  it('names each project repo and the worktrees root; empty without repos', () => {
    expect(codeBriefLine({ projects: {}, paths: { worktrees_root: '/wt' } } as never)).toBe('');
    projects.wavepulse = { workspace_match: '**/wavepulse*', repo: '/home/wave/repos/wavepulse' };
    const line = codeBriefLine({ projects, paths: { worktrees_root: '/home/wave/.wavecode-data/worktrees' } } as never);
    expect(line).toContain('wavepulse → /home/wave/repos/wavepulse');
    expect(line).toContain('/home/wave/.wavecode-data/worktrees/<agent>');
    expect(line).toContain('your seat directory is not a checkout');
  });
});
