/**
 * Reply extraction on real-shaped pane captures (spec §5b): final prose
 * only, chrome stripped per runtime, never the echoed prompt.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { clipReply, extractReply, findPromptEcho, MAX_REPLY_CHARS, stripAnsi } from './reply-extractors.js';

const pane = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '__fixtures__', 'panes', name), 'utf8');

const NOISE = /●|⏺|⎿|Running…|Bash\(|Read\(|✻|⏵⏵|╭|╰|│|esc to interrupt|gpt-5|⏎ send|Worked for|Responded for|^›|^>/m;

describe('reply extraction', () => {
  it('Claude Code: final prose after tool calls — no ● Running… / ⎿ / spinner / prompt box', () => {
    const prompt = 'what changed in auth.ts? summarize it and run the auth tests please, then tell me if anything is red';
    const { text, anchored } = extractReply('claude-code', pane('claude-tools.txt'), prompt);
    expect(anchored).toBe(true);
    expect(text).toBe([
      'Two changes landed in auth.ts:',
      '',
      '1. Unknown bearer tokens now get 401 in tailscale mode instead of',
      '   falling back to the admin owner.',
      '2. The middleware resolves every token to a user and sets it on the',
      '   request.',
      '',
      'The auth tests are green (14/14) — nothing is red.',
    ].join('\n'));
    expect(text).not.toMatch(NOISE);
    // the earlier turn and the intermediate "I'll look…" are not the final answer
    expect(text).not.toContain('TypeScript monorepo');
    expect(text).not.toContain("I'll look");
  });

  it('Claude Code PM seat: MCP tool blocks dropped, the question and [ ] options kept', () => {
    const { text } = extractReply('claude-code', pane('claude-pm-question.txt'), 'what is chatgpt-countix doing?');
    expect(text.startsWith('chatgpt-countix (Denis\'s lane) is running the invoices test suite for T12')).toBe(true);
    expect(text).toContain('Codex2 finished the email fixes');
    expect(text.split('\n').slice(-4)).toEqual([
      "Want me to line up Fable to review Codex2's email fixes now?",
      '[ ] Review now',
      '[ ] After invoices passes',
      '[ ] Hold',
    ]);
    expect(text).not.toMatch(/MCP|list_agents|⎿|IDE disconnected/);
  });

  it('Codex: › composer, status line, Explored/Ran blocks and Worked-for rule stripped', () => {
    const { text } = extractReply('codex', pane('codex.txt'), 'what is the status of the leases lane?');
    expect(text).toBe([
      'The leases lane is complete: reserve/release, ownership guards and',
      'expiry are in, and all 24 lease tests pass.',
      '',
      'Next step is the MCP tools (T3).',
    ].join('\n'));
    expect(text).not.toMatch(NOISE);
  });

  it('Grok (block TUI): tool blocks and status bar stripped', () => {
    const { text } = extractReply('grok', pane('grok-blocks.txt'), 'how many agents are idle?');
    expect(text).toBe('Three agents are idle: pm, codex-rev and grok-fe. builder is working on\nT7 (reply capture).');
  });

  it('Grok (plain text TUI) and unknown runtimes: chrome lines dropped', () => {
    const { text } = extractReply('grok', pane('grok-plain.txt'), 'say hi to the team');
    expect(text).toBe('Hello team! The board is green and nothing needs a decision right now.');
    expect(extractReply('aider-qwen', pane('grok-plain.txt'), 'say hi to the team').text)
      .toBe('Hello team! The board is green and nothing needs a decision right now.');
  });

  it('never contains the echoed prompt, for every runtime fixture', () => {
    const cases: Array<[string, string, string]> = [
      ['claude-code', 'claude-tools.txt', 'what changed in auth.ts? summarize it and run the auth tests please, then tell me if anything is red'],
      ['claude-code', 'claude-pm-question.txt', 'what is chatgpt-countix doing?'],
      ['codex', 'codex.txt', 'what is the status of the leases lane?'],
      ['grok', 'grok-blocks.txt', 'how many agents are idle?'],
      ['grok', 'grok-plain.txt', 'say hi to the team'],
    ];
    for (const [runtime, file, prompt] of cases) {
      const { text } = extractReply(runtime, pane(file), prompt);
      expect(text.toLowerCase(), file).not.toContain(prompt.toLowerCase().slice(0, 24));
      expect(text, file).not.toBe('');
    }
  });

  it('a prompt echo that wraps onto continuation lines is not part of the reply', () => {
    const capture = '> please summarize the release notes for the\n  multi-orchestrator lane\n\n● Summary: users, leases, profiles.\n';
    expect(extractReply('claude-code', capture, 'please summarize the release notes for the multi-orchestrator lane').text)
      .toBe('Summary: users, leases, profiles.');
  });

  it('finds the latest echo (a prompt asked twice anchors on the second)', () => {
    const lines = ['> status?', '● Old answer.', '> status?', '● New answer.'];
    expect(findPromptEcho(lines, 'status?')).toBe(2);
    expect(extractReply('claude-code', lines.join('\n'), 'status?').text).toBe('New answer.');
  });

  it('without a prompt (run summaries) the final prose of the capture is used', () => {
    expect(extractReply('codex', pane('codex.txt')).text).toContain('Next step is the MCP tools (T3).');
  });

  it('a turn that ended on a tool call keeps the last prose before it', () => {
    const capture = '> deploy\n\n● Deploying now.\n\n● Bash(./deploy.sh)\n  ⎿  done\n';
    expect(extractReply('claude-code', capture, 'deploy').text).toBe('Deploying now.');
  });

  it('caps replies at 4 000 chars keeping head and tail', () => {
    const long = `START ${'word '.repeat(2000)} END`;
    const clipped = clipReply(long);
    expect(clipped.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(clipped.startsWith('START')).toBe(true);
    expect(clipped.endsWith('END')).toBe(true);
    expect(clipped).toContain('[…]');
    expect(clipReply('short')).toBe('short');
  });

  it('strips ANSI colour codes', () => {
    expect(stripAnsi('\x1b[1m● \x1b[32mok\x1b[0m')).toBe('● ok');
    expect(extractReply('claude-code', '\x1b[2m> hi\x1b[0m\n\x1b[1m●\x1b[0m Hello there.', 'hi').text).toBe('Hello there.');
  });
});
