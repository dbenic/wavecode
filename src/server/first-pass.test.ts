import { describe, expect, it } from 'vitest';
import type { Agent } from './db.js';
import { chooseFirstPassSeat, firstPassFileName, firstPassPrompt, isFirstPassFileName, parseFirstPass } from './first-pass.js';

function seat(name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id: extra.id ?? name, name, runtime: extra.runtime ?? 'codex', tmux_session: `tmux-${name}`, workspace: null,
    mode: extra.mode ?? 'spawned', status: extra.status ?? 'idle', model: null, effort: null,
    profile: extra.profile ?? null, role: extra.role ?? null, alias: extra.alias ?? null, persona: null, created_at: '',
  };
}

describe('first-pass files', () => {
  it('names the file by sha8 and UTC day, and recognises it', () => {
    const name = firstPassFileName('A9D705D1B92D6B23CE7D56F41179CF4995B7CEC8', new Date('2026-10-25T23:30:00Z'));
    expect(name).toBe('wave-firstpass-a9d705d1-20261025.md');
    expect(isFirstPassFileName(name)).toBe(true);
    expect(isFirstPassFileName('/home/wave/inbox/wave-firstpass-a9d705d1-20261025-codex2.md')).toBe(true);
    expect(isFirstPassFileName('codex3-verdict-a9d705d1-20261025.md')).toBe(false);
    expect(isFirstPassFileName('wave-firstpass-a9d705d1-20261025.log')).toBe(false);
  });

  it('parses the last FIRST PASS line, counts severity-tagged issues, and prefers the full SHA in the body', () => {
    const text = [
      '# First pass: wc-codex6',
      'SHA: a9d705d1b92d6b23ce7d56f41179cf4995b7cec8',
      'Seat: @codex2',
      'Write FIRST PASS: PASS or FIRST PASS: NEEDS FIXES at the end.',
      'ISSUES:',
      '- [HIGH] src/x.ts:10 — bug',
      '- [low] src/y.ts:2 — missing test',
      '- plain note without a tag',
      '**FIRST PASS: NEEDS FIXES**',
    ].join('\n');
    expect(parseFirstPass(text, 'wave-firstpass-a9d705d1-20261025.md')).toEqual({
      sha: 'a9d705d1b92d6b23ce7d56f41179cf4995b7cec8', result: 'needs-fixes', issues: 2, file: 'wave-firstpass-a9d705d1-20261025.md', seat: 'codex2',
    });
    expect(parseFirstPass('ISSUES:\nnone\nFIRST PASS: PASS\n', '/inbox/wave-firstpass-a9d705d1-20261025.md')).toMatchObject({ sha: 'a9d705d1', result: 'pass', issues: 0, seat: null });
    expect(parseFirstPass('still writing', 'wave-firstpass-a9d705d1-20261025.md')).toBeNull();
    expect(parseFirstPass('FIRST PASS: PASS', 'codex2-notes.md')).toBeNull();
    // A VERDICT line is not a first pass result.
    expect(parseFirstPass('VERDICT: PASS', 'wave-firstpass-a9d705d1-20261025.md')).toBeNull();
  });

  it('prompt tells the seat where to read, what to write, and never to write VERDICT', () => {
    const text = firstPassPrompt({
      sha: 'a9d705d1b92d6b23ce7d56f41179cf4995b7cec8', lane: 'wc-codex6', authorName: 'codex6', freezePath: '/inbox/codex6-freeze.md',
      repo: '/home/wave/repos/wavepulse', remote: 'origin', file: '/inbox/wave-firstpass-a9d705d1-20261025.md', seatName: 'codex2',
    });
    expect(text).toContain('git fetch origin wc-codex6');
    expect(text).toContain('git diff origin/main...a9d705d1b92d6b23ce7d56f41179cf4995b7cec8');
    expect(text).toContain('Write /inbox/wave-firstpass-a9d705d1-20261025.md');
    expect(text).toContain('Never write the word VERDICT');
    expect(text).toContain('Seat: @codex2');
  });
});

describe('chooseFirstPassSeat', () => {
  const load = (loads: Record<string, { leftPct?: number | null; openReviews?: number }>) => (agent: Agent) => ({
    busy: agent.status === 'working', openReviews: 0, runningTasks: 0, lastAssignedAt: 0, leftPct: null, ...loads[agent.id],
  });

  it('picks the least-loaded listed seat with capacity, never the author or the author\'s own seats', () => {
    const author = seat('codex6', { profile: 'denis20x' });
    const codex2 = seat('codex2', { profile: 'denis2' });
    const codex3 = seat('codex3', { profile: 'pool' });
    const codex7 = seat('codex7', { profile: 'denis20x' });
    const pm = seat('pm', { role: 'orchestrator' });
    const agents = [author, codex2, codex3, codex7, pm];
    expect(chooseFirstPassSeat(author, agents, { seats: ['codex2', 'codex3', 'pm'] }, { load: load({}) })?.name).toBe('codex2');
    expect(chooseFirstPassSeat(author, agents, { seats: ['codex2', 'codex3'] }, { load: load({ codex2: { openReviews: 2 } }) })?.name).toBe('codex3');
    expect(chooseFirstPassSeat(author, agents, { seats: ['codex2', 'codex3'] }, { load: load({ codex2: { leftPct: 3 } }), floor: 10 })?.name).toBe('codex3');
    expect(chooseFirstPassSeat(author, agents, { seats: ['codex2'] }, { load: load({}), deny: ['codex2'] })).toBeNull();
    expect(chooseFirstPassSeat(author, agents, { seats: ['codex6', 'codex7'] }, { load: load({}) })).toBeNull();
    expect(chooseFirstPassSeat(author, agents, { seats: ['codex7'] }, { load: load({}), serviceProfiles: ['denis20x'] })?.name).toBe('codex7');
    expect(chooseFirstPassSeat(author, agents, { seats: ['nobody'] }, { load: load({}) })).toBeNull();
  });
});
