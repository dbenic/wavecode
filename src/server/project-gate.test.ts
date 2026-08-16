import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from './db.js';
import type { ProjectConfig } from './config.js';

const projects: Record<string, ProjectConfig> = {};

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ projects })),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const GREEN_LINE =
  'RESULT GREEN branch=landing-v3-human-first sha=abc12345 lint=PASS unit=PASS frontend=PASS';
const RED_LINE =
  'RESULT RED branch=landing-v3-human-first sha=def67890 lint=PASS unit=FAIL frontend=PASS';

function wavepulseProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    workspace_match: '**/wavepulse*',
    gate: {
      command: 'wavepulse-gate',
      branch: 'landing-v3-human-first',
      mode: 'full',
    },
    require_result_to_promote: true,
    ...overrides,
  };
}

describe('project-gate.ts', () => {
  let tmpDir: string;
  let dbPath: string;
  let logsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    for (const key of Object.keys(projects)) delete projects[key];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-gate-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    logsDir = path.join(tmpDir, 'gate-results');
    fs.mkdirSync(logsDir, { recursive: true });

    const db = await import('./db.js');
    db.initDb(dbPath);

    const gate = await import('./project-gate.js');
    gate.setGateExecForTest(null);
  });

  afterEach(async () => {
    const gate = await import('./project-gate.js');
    gate.setGateExecForTest(null);
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeLog(name: string, body: string, mtimeMs?: number): string {
    const full = path.join(logsDir, name);
    fs.writeFileSync(full, body);
    if (mtimeMs !== undefined) fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
    return full;
  }

  function agent(workspace: string | null, name = 'opus-wavepulse'): Agent {
    return {
      id: 'agent-1',
      name,
      runtime: 'codex',
      tmux_session: 'wc-opus',
      workspace,
      mode: 'spawned',
      status: 'idle',
      model: null,
      effort: null,
      created_at: '2026-08-16T00:00:00Z',
    };
  }

  describe('workspace matching', () => {
    it('matches glob and prefix; unmatched workspaces are not gated', async () => {
      const gate = await import('./project-gate.js');
      projects.wavepulse = wavepulseProject();

      expect(gate.workspaceMatches('/srv/wavepulse', '**/wavepulse*')).toBe(true);
      expect(gate.workspaceMatches('/srv/wavepulse-app', '**/wavepulse*')).toBe(true);
      expect(gate.workspaceMatches('/srv/countix', '**/wavepulse*')).toBe(false);
      expect(gate.workspaceMatches('/srv/wavepulse/src', '/srv/wavepulse')).toBe(true);
      expect(gate.workspaceMatches('/srv/wavepulse-other', '/srv/wavepulse')).toBe(false);

      expect(gate.findGatedProject('/srv/wavepulse')).not.toBeNull();
      expect(gate.findGatedProject('/srv/countix-ms')).toBeNull();
      expect(gate.projectRequiresReferee('/srv/countix-ms')).toBe(false);
      expect(gate.projectRequiresReferee(null)).toBe(false);
    });

    it('does not treat a project without a gate as a referee', async () => {
      const gate = await import('./project-gate.js');
      projects.docs = { workspace_match: '**/docs*' };
      expect(gate.findGatedProject('/srv/docs')).toBeNull();
    });
  });

  describe('RESULT / log parsing', () => {
    it('parses RESULT and log: lines, including optional api-strict', async () => {
      const gate = await import('./project-gate.js');
      const parsed = gate.parseResultLine(
        `${GREEN_LINE} api-strict=FAIL\nlog: /tmp/gate.log\n`,
      );
      expect(parsed).toMatchObject({
        verdict: 'GREEN',
        branch: 'landing-v3-human-first',
        sha: 'abc12345',
        apiStrict: 'FAIL',
      });
      expect(parsed?.raw).toBe(`${GREEN_LINE} api-strict=FAIL`);
      expect(gate.parseLogPath(`noise\nlog: /tmp/gate.log\n`)).toBe('/tmp/gate.log');
    });

    it('extracts FAIL file names and the first assertion', async () => {
      const gate = await import('./project-gate.js');
      const log = [
        'FAIL  tests/api/regression.test.ts',
        'FAIL  tests/api/booking-proposal.test.ts > suite',
        '    expected 200, got 500',
        'Error: boom',
      ].join('\n');
      expect(gate.parseFailingFiles(log)).toEqual([
        'tests/api/regression.test.ts',
        'tests/api/booking-proposal.test.ts',
      ]);
      expect(gate.firstAssertionFromLog(log)).toBe('expected 200, got 500');
    });
  });

  describe('maybeInvokeProjectGate', () => {
    it('does not invoke the referee for an unmatched workspace', async () => {
      const exec = vi.fn();
      const gate = await import('./project-gate.js');
      projects.wavepulse = wavepulseProject();
      gate.setGateExecForTest(exec);

      const result = await gate.maybeInvokeProjectGate('run-1', agent('/srv/countix-ms'));
      expect(result).toBeNull();
      expect(exec).not.toHaveBeenCalled();
      expect(gate.getStoredGateResult('run-1')).toBeNull();
    });

    it('invokes wavepulse-gate <branch> full with no worktree cwd and persists RESULT', async () => {
      const exec = vi.fn().mockResolvedValue({
        stdout: `${GREEN_LINE}\nlog: /tmp/green.log\n`,
        stderr: '',
        exitCode: 0,
      });
      const gate = await import('./project-gate.js');
      const events = await import('./event-bus.js');
      projects.wavepulse = wavepulseProject();
      gate.setGateExecForTest(exec);

      const result = await gate.maybeInvokeProjectGate('run-green', agent('/srv/apps/wavepulse'));

      expect(exec).toHaveBeenCalledWith(
        'wavepulse-gate',
        ['landing-v3-human-first', 'full'],
        expect.objectContaining({ timeout: gate.GATE_FULL_TIMEOUT_MS }),
      );
      const opts = exec.mock.calls[0][2] as Record<string, unknown>;
      expect(opts).not.toHaveProperty('cwd');
      expect(result?.result_line).toBe(GREEN_LINE);
      expect(result?.sha).toBe('abc12345');
      expect(result?.exit_code).toBe(0);
      expect(gate.getStoredGateResult('run-green')?.result_line).toBe(GREEN_LINE);
      expect(events.emit).toHaveBeenCalledWith(
        'gate.checked',
        'run',
        'run-green',
        expect.objectContaining({ result_line: GREEN_LINE, sha: 'abc12345' }),
      );
    });

    it('uses a per-agent branch override when configured', async () => {
      const exec = vi.fn().mockResolvedValue({
        stdout: 'RESULT GREEN branch=feat-x sha=11111111 lint=PASS unit=PASS frontend=PASS\n',
        stderr: '',
        exitCode: 0,
      });
      const gate = await import('./project-gate.js');
      projects.wavepulse = wavepulseProject({
        agent_branches: { 'opus-wavepulse': 'feat-x' },
      });
      gate.setGateExecForTest(exec);

      await gate.maybeInvokeProjectGate('run-br', agent('/srv/wavepulse', 'opus-wavepulse'));
      expect(exec).toHaveBeenCalledWith(
        'wavepulse-gate',
        ['feat-x', 'full'],
        expect.any(Object),
      );
    });
  });

  describe('evaluateRefereeForPromote', () => {
    it('allows promote when no project is gated', async () => {
      const gate = await import('./project-gate.js');
      expect(gate.evaluateRefereeForPromote('run-x', '/srv/countix-ms').ok).toBe(true);
    });

    it('blocks promote without a stored RESULT', async () => {
      const gate = await import('./project-gate.js');
      projects.wavepulse = wavepulseProject();
      const result = gate.evaluateRefereeForPromote('run-missing', '/srv/wavepulse');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('no referee RESULT');
    });

    it('allows GREEN', async () => {
      const gate = await import('./project-gate.js');
      projects.wavepulse = wavepulseProject();
      gate.storeGateResult('run-green', {
        result_line: GREEN_LINE,
        log_path: null,
        exit_code: 0,
        mode: 'full',
        branch: 'landing-v3-human-first',
        sha: 'abc12345',
        checked_at: '2026-08-16T00:00:00Z',
      });
      expect(gate.evaluateRefereeForPromote('run-green', '/srv/wavepulse').ok).toBe(true);
    });

    it('allows RED when failing files are a subset of the newest nightly full log', async () => {
      const gate = await import('./project-gate.js');
      const baseline = writeLog(
        'landing-v3-human-first-aaaa-20260815-023000-full.log',
        'FAIL  tests/api/regression.test.ts\nFAIL  tests/api/booking-proposal.test.ts\n',
        Date.now() - 60_000,
      );
      const newer = writeLog(
        'landing-v3-human-first-bbbb-20260816-023000-full.log',
        'FAIL  tests/api/regression.test.ts\nFAIL  tests/api/registry.test.ts\n',
        Date.now(),
      );
      expect(newer).not.toBe(baseline);

      const thisLog = writeLog(
        'this-red.log',
        'FAIL  tests/api/regression.test.ts\n    expected 1, got 2\n',
      );
      projects.wavepulse = wavepulseProject({
        gate: {
          command: 'wavepulse-gate',
          branch: 'landing-v3-human-first',
          mode: 'full',
          baseline_glob: path.join(logsDir, 'landing-v3-human-first-*-full.log'),
        },
      });
      gate.storeGateResult('run-red-known', {
        result_line: RED_LINE,
        log_path: thisLog,
        exit_code: 1,
        mode: 'full',
        branch: 'landing-v3-human-first',
        sha: 'def67890',
        checked_at: '2026-08-16T00:00:00Z',
      });

      expect(gate.evaluateRefereeForPromote('run-red-known', '/srv/wavepulse').ok).toBe(true);
    });

    it('blocks RED with a new failing file and bounces RESULT + file + assertion', async () => {
      const gate = await import('./project-gate.js');
      writeLog(
        'landing-v3-human-first-bbbb-20260816-023000-full.log',
        'FAIL  tests/api/regression.test.ts\n',
        Date.now(),
      );
      const thisLog = writeLog(
        'this-new.log',
        [
          'FAIL  tests/api/regression.test.ts',
          'FAIL  tests/api/brand-new.test.ts',
          'Error: expected 200, got 500',
        ].join('\n'),
      );
      projects.wavepulse = wavepulseProject({
        gate: {
          command: 'wavepulse-gate',
          branch: 'landing-v3-human-first',
          mode: 'full',
          baseline_glob: path.join(logsDir, 'landing-v3-human-first-*-full.log'),
        },
      });
      gate.storeGateResult('run-red-new', {
        result_line: RED_LINE,
        log_path: thisLog,
        exit_code: 1,
        mode: 'full',
        branch: 'landing-v3-human-first',
        sha: 'def67890',
        checked_at: '2026-08-16T00:00:00Z',
      });

      const result = gate.evaluateRefereeForPromote('run-red-new', '/srv/wavepulse');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(RED_LINE);
        expect(result.error).toContain('tests/api/brand-new.test.ts');
        expect(result.error).not.toContain('tests/api/regression.test.ts');
        expect(result.error).toContain('Error: expected 200, got 500');
        expect(result.error).not.toMatch(/author|self-report|I finished/i);
      }
    });

    it('blocks exit 2 / missing RESULT even if a human says known-red', async () => {
      const gate = await import('./project-gate.js');
      projects.wavepulse = wavepulseProject();
      gate.storeGateResult('run-fatal', {
        result_line: null,
        log_path: null,
        exit_code: 2,
        mode: 'full',
        branch: 'landing-v3-human-first',
        sha: null,
        checked_at: '2026-08-16T00:00:00Z',
      });
      const result = gate.evaluateRefereeForPromote('run-fatal', '/srv/wavepulse');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/no referee RESULT|FATAL/);
    });
  });
});
