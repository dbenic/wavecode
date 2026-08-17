import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RESULT_FAIL_LINE,
  RESULT_FILE_MAX_BYTES,
  RESULT_PASS_LINE,
  RESULT_REASON_MAX_CHARS,
  appendRunResultBriefing,
  buildRunResultBriefing,
  exitCodeForVerdict,
  parseRunResultText,
  presentRunResult,
  readRunResult,
  resolveRunResultPath,
  runResultRelPath,
  settleRunResultFile,
  writeRunResult,
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

  it('resolves runs/<run_id>/result.txt under the WaveCode data dir', () => {
    const runId = '01M08B7WSC1F3XKYQMNYMC68YB';
    expect(runResultRelPath(runId)).toBe(path.join('runs', runId, 'result.txt'));
    const resolved = resolveRunResultPath(runId, '/ws/agent');
    expect(resolved.endsWith(path.join('runs', runId, 'result.txt'))).toBe(true);
    expect(resolved).not.toContain(`${path.sep}.wavecode${path.sep}`);
  });

  it('overwrites a small RESULT file once; last line is PASS or FAIL plus a reason', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    writeRunResult(filePath, 'FAIL', 'Idle close without a parseable RESULT file');
    const first = fs.readFileSync(filePath, 'utf8');
    expect(first.trim().split('\n').at(-1)).toBe(RESULT_FAIL_LINE);
    expect(first.split('\n')[0]).toBe('Idle close without a parseable RESULT file');

    writeRunResult(filePath, 'PASS', 'Tests and review are green');
    const after = fs.readFileSync(filePath, 'utf8');
    expect(after).not.toContain('Idle close without a parseable RESULT file');
    expect(after.trim().split('\n')).toEqual(['Tests and review are green', RESULT_PASS_LINE]);
    expect(after.length).toBeLessThan(RESULT_FILE_MAX_BYTES);
  });

  it('caps the reason so the file cannot grow', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    writeRunResult(filePath, 'FAIL', 'x'.repeat(5000));
    const text = fs.readFileSync(filePath, 'utf8');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(RESULT_FILE_MAX_BYTES);
    expect(text.split('\n')[0]?.length).toBe(RESULT_REASON_MAX_CHARS);
    expect(text.trim().split('\n').at(-1)).toBe(RESULT_FAIL_LINE);
  });

  it('settle rewrites an oversized file to the cap and does not treat it as PASS unless last line is PASS', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    fs.writeFileSync(filePath, `${'junk\n'.repeat(2000)}Reviewed auth.ts; 2 issues remain\n${RESULT_FAIL_LINE}\n`, 'utf8');
    expect(fs.statSync(filePath).size).toBeGreaterThan(RESULT_FILE_MAX_BYTES);
    const settled = settleRunResultFile(filePath, 'Idle close without a parseable RESULT file');
    expect(settled.verdict).toBe('FAIL');
    expect(settled.reason).toBe('Reviewed auth.ts; 2 issues remain');
    expect(fs.statSync(filePath).size).toBeLessThanOrEqual(RESULT_FILE_MAX_BYTES);
    expect(fs.readFileSync(filePath, 'utf8').trim().split('\n')).toEqual([
      'Reviewed auth.ts; 2 issues remain',
      RESULT_FAIL_LINE,
    ]);
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

  it('settle overwrites FAIL when the file is missing or unparseable, and never invents PASS', () => {
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
    expect(fs.readFileSync(grokPane, 'utf8')).not.toContain('reviewed by another AI');
  });

  it('settle keeps a valid agent-written PASS and does not overwrite it', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    writeRunResult(filePath, 'PASS', 'All checks green');
    const settled = settleRunResultFile(filePath, 'Idle close without a parseable RESULT file');
    expect(settled).toMatchObject({ verdict: 'PASS', reason: 'All checks green' });
    expect(exitCodeForVerdict(settled.verdict)).toBe(0);
  });

  it('forceFail overwrites with a small FAIL so cancel/reject is not PASS', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    writeRunResult(filePath, 'PASS', 'All checks green');
    const settled = settleRunResultFile(filePath, 'Task cancelled', { forceFail: true });
    expect(settled.verdict).toBe('FAIL');
    expect(settled.reason).toBe('Task cancelled');
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).not.toContain('All checks green');
    expect(text.trim().split('\n')).toEqual(['Task cancelled', RESULT_FAIL_LINE]);
  });

  it('API presentation exposes path, verdict, and reason; missing is not PASS', () => {
    const filePath = path.join(tmpDir(), 'result.txt');
    expect(presentRunResult(filePath)).toEqual({
      result_path: filePath,
      result: null,
      result_reason: null,
      result_last_line: null,
    });
    writeRunResult(filePath, 'FAIL', 'No parseable RESULT file');
    expect(presentRunResult(filePath)).toEqual({
      result_path: filePath,
      result: 'FAIL',
      result_reason: 'No parseable RESULT file',
      result_last_line: RESULT_FAIL_LINE,
    });
  });

  it('briefs the agent to write the file once and never mentions echo|nc or a message bus', () => {
    const resultPath = '/data/runs/01ABC/result.txt';
    const briefing = buildRunResultBriefing(resultPath);
    expect(briefing).toContain(resultPath);
    expect(briefing).toContain('write this small file once');
    expect(briefing).toContain('overwrite');
    expect(briefing).toContain('do not append');
    expect(briefing).toContain(RESULT_PASS_LINE);
    expect(briefing).toContain(RESULT_FAIL_LINE);
    expect(briefing).not.toMatch(/echo\s*\|?\s*nc/i);
    expect(briefing).not.toContain('nc -U');
    expect(briefing).not.toMatch(/pubsub|protobuf|message bus/i);
    expect(appendRunResultBriefing('Do the review', resultPath)).toContain('Do the review');
    expect(appendRunResultBriefing('Do the review', resultPath)).toContain(resultPath);
  });
});
