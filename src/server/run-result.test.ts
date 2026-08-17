import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESULT_FAIL_LINE,
  RESULT_PASS_LINE,
  appendRunResult,
  appendRunResultBriefing,
  buildRunResultBriefing,
  exitCodeForVerdict,
  parseRunResultText,
  presentRunResult,
  readRunResult,
  resolveRunResultPath,
  runResultRelPath,
  settleRunResultFile,
} from './run-result.js';

describe('run-result', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-run-result-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('resolves a stable workspace path under .wavecode/runs/<id>/result.txt', () => {
    const runId = '01M08B7WSC1F3XKYQMNYMC68YB';
    expect(runResultRelPath(runId)).toBe(path.join('.wavecode', 'runs', runId, 'result.txt'));
    expect(resolveRunResultPath(runId, '/ws/agent')).toBe(
      path.join('/ws/agent', '.wavecode', 'runs', runId, 'result.txt'),
    );
  });

  it('appends RESULT: PASS or RESULT: FAIL as the last line plus a one-line reason', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    appendRunResult(filePath, 'FAIL', 'Idle close without a parseable RESULT file');
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.replace(/\n$/, '').split('\n');
    expect(lines.at(-1)).toBe(RESULT_FAIL_LINE);
    expect(lines[0]).toBe('Idle close without a parseable RESULT file');
    expect(lines[0]).not.toContain('\n');

    appendRunResult(filePath, 'PASS', 'Tests and review are green');
    const after = fs.readFileSync(filePath, 'utf8');
    expect(after).toContain('Idle close without a parseable RESULT file');
    expect(after.trim().split('\n').at(-1)).toBe(RESULT_PASS_LINE);
    expect(parseRunResultText(after)?.verdict).toBe('PASS');
  });

  it('parses the last non-empty line and the reason above it', () => {
    const parsed = parseRunResultText('Reviewed auth.ts; 2 issues remain\nRESULT: FAIL\n');
    expect(parsed).toEqual({
      verdict: 'FAIL',
      reason: 'Reviewed auth.ts; 2 issues remain',
      lastLine: RESULT_FAIL_LINE,
    });
    expect(parseRunResultText(`ok\n${RESULT_PASS_LINE}\n\n`)).toMatchObject({
      verdict: 'PASS',
      reason: 'ok',
    });
  });

  it('treats missing, unparseable, and pane-only text as not PASS', () => {
    const dir = tmpDir();
    const missing = path.join(dir, 'missing.txt');
    expect(readRunResult(missing)).toBeNull();
    expect(readRunResult(null)).toBeNull();
    expect(exitCodeForVerdict(readRunResult(missing)?.verdict)).toBe(1);

    expect(parseRunResultText('')).toBeNull();
    expect(parseRunResultText('RESULT: PASS lint=PASS unit=PASS')).toBeNull();
    expect(parseRunResultText('RESULT PASS')).toBeNull();
    expect(parseRunResultText('Your code was reviewed by another AI model. Here are the issues found.')).toBeNull();
    expect(parseRunResultText('RESULT: FAIL extra')).toBeNull();

    const pane = path.join(dir, 'pane.txt');
    fs.writeFileSync(pane, 'Your code was reviewed by another AI model. Here are the issues found.\n', 'utf8');
    expect(readRunResult(pane)).toBeNull();
    expect(presentRunResult(pane).result).toBeNull();
  });

  it('settle appends FAIL when the file is missing or unparseable, and never invents PASS', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    const settled = settleRunResultFile(filePath, 'Idle close without a parseable RESULT file');
    expect(settled.verdict).toBe('FAIL');
    expect(settled.lastLine).toBe(RESULT_FAIL_LINE);
    expect(fs.readFileSync(filePath, 'utf8').trim().split('\n').at(-1)).toBe(RESULT_FAIL_LINE);
    expect(exitCodeForVerdict(settled.verdict)).toBe(1);

    const grokPane = path.join(tmpDir(), 'grok.txt');
    fs.writeFileSync(
      grokPane,
      'Your code was reviewed by another AI model. Here are the issues found.\n',
      'utf8',
    );
    const fromPane = settleRunResultFile(grokPane, 'Idle close without a parseable RESULT file');
    expect(fromPane.verdict).toBe('FAIL');
    expect(fromPane.verdict).not.toBe('PASS');
  });

  it('settle keeps a valid agent-written PASS and does not append over it', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    appendRunResult(filePath, 'PASS', 'All checks green');
    const settled = settleRunResultFile(filePath, 'Idle close without a parseable RESULT file');
    expect(settled).toMatchObject({ verdict: 'PASS', reason: 'All checks green' });
    expect(exitCodeForVerdict(settled.verdict)).toBe(0);
    expect(fs.readFileSync(filePath, 'utf8').trim().split('\n').filter((l) => l.startsWith('RESULT:'))).toEqual([
      RESULT_PASS_LINE,
    ]);
  });

  it('forceFail appends FAIL so cancel/reject last-line is not PASS', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    appendRunResult(filePath, 'PASS', 'All checks green');
    const settled = settleRunResultFile(filePath, 'Task cancelled', { forceFail: true });
    expect(settled.verdict).toBe('FAIL');
    expect(settled.reason).toBe('Task cancelled');
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).toContain('All checks green');
    expect(text.trim().split('\n').at(-1)).toBe(RESULT_FAIL_LINE);
  });

  it('API presentation exposes path, verdict, and reason; missing is not PASS', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    expect(presentRunResult(filePath)).toEqual({
      result_path: filePath,
      result: null,
      result_reason: null,
      result_last_line: null,
    });
    appendRunResult(filePath, 'FAIL', 'No parseable RESULT file');
    expect(presentRunResult(filePath)).toEqual({
      result_path: filePath,
      result: 'FAIL',
      result_reason: 'No parseable RESULT file',
      result_last_line: RESULT_FAIL_LINE,
    });
  });

  it('briefs the agent to append the file and never mentions echo|nc or a message bus', () => {
    const resultPath = '/ws/agent/.wavecode/runs/01ABC/result.txt';
    const briefing = buildRunResultBriefing(resultPath);
    expect(briefing).toContain(resultPath);
    expect(briefing).toContain('append');
    expect(briefing).toContain(RESULT_PASS_LINE);
    expect(briefing).toContain(RESULT_FAIL_LINE);
    expect(briefing).not.toMatch(/echo\s*\|?\s*nc/i);
    expect(briefing).not.toContain('nc -U');
    expect(briefing).not.toMatch(/pubsub|protobuf|message bus/i);
    expect(appendRunResultBriefing('Do the review', resultPath)).toContain('Do the review');
    expect(appendRunResultBriefing('Do the review', resultPath)).toContain(resultPath);
  });
});
