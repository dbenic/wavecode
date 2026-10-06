import { describe, expect, it } from 'vitest';
import type { Agent, Task, User } from '../types';
import { findAgent, parseComposer, STATUS_PROMPT, suggestionsFor, tokenAt, type GrammarContext } from './composer-grammar';

function agent(over: Partial<Agent>): Agent {
  return {
    id: `id-${over.name}`, name: 'x', runtime: 'claude-code', tmux_session: 'wc', workspace: null,
    mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', ...over,
  };
}

const toni = agent({ name: 'claude-fe-1', alias: 'toni', tags: ['frontend'], persona: 'frontend lead' });
const mia = agent({ name: 'grok-fe-2', alias: 'mia', tags: ['frontend'] });
const rex = agent({ name: 'codex-be', alias: 'rex', status: 'working' });
const pm = agent({ name: 'pm', orchestrator: true });
const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };
const tasks: Task[] = [
  { id: 't-1', num: 1, agent_id: null, prompt: 'identity', status: 'done', priority: 0, created_at: '', latest_run: { id: 'r-1' } },
  { id: 't-2', num: 2, agent_id: null, prompt: 'leases', status: 'pending', priority: 0, created_at: '' },
  { id: 't-12', num: 12, agent_id: null, prompt: 'board', status: 'running', priority: 0, created_at: '' },
];

const ctx: GrammarContext = { agents: [toni, mia, rex, pm], users: [ana], tasks, seat: pm, chip: pm };

describe('composer grammar (spec §5c)', () => {
  describe('acceptance', () => {
    it('#reserve @toni 2h', () => {
      expect(parseComposer('#reserve @toni 2h', ctx)).toEqual({ kind: 'reserve', agent: toni, hours: 2 });
    });

    it("@toni @mia review each other's lane → one prompt to each", () => {
      expect(parseComposer("@toni @mia review each other's lane", ctx)).toEqual({
        kind: 'prompt', agents: [toni, mia], text: "review each other's lane",
      });
    });

    it('#review #12 @toni (either order) names the reviewer for a task; malformed → the seat', () => {
      expect(parseComposer('#review #12 @toni', ctx)).toEqual({ kind: 'review', task: tasks[2], agent: toni });
      expect(parseComposer('#review @toni 12', ctx)).toEqual({ kind: 'review', task: tasks[2], agent: toni });
      expect(parseComposer('#review @toni', ctx).kind).toBe('prompt');
      expect(parseComposer('#review #12 @nobody', ctx).kind).toBe('prompt');
    });

    it('#ask deploy/fable <question> asks an agent on another WaveCode instance', () => {
      expect(parseComposer('#ask deploy/fable is the invoices table migrated on staging?', ctx)).toEqual({
        kind: 'ask_peer', peer: 'deploy', agent: 'fable', text: 'is the invoices table migrated on staging?',
      });
      expect(parseComposer('#ask deploy/@fable  hi', ctx)).toMatchObject({ kind: 'ask_peer', agent: 'fable', text: 'hi' });
      expect(parseComposer('#ask deploy/fable', ctx).kind).toBe('prompt'); // no question → seat
    });

    it('an unknown #foo goes to the orchestrator seat unchanged', () => {
      expect(parseComposer('#foo do the thing', ctx)).toEqual({ kind: 'prompt', agents: [pm], text: '#foo do the thing' });
      // even when the chip points elsewhere
      expect(parseComposer('#foo', { ...ctx, chip: rex })).toEqual({ kind: 'prompt', agents: [pm], text: '#foo' });
    });

    it('@frontend with two tagged agents sends to both', () => {
      expect(parseComposer('@frontend ship the header', ctx)).toEqual({ kind: 'prompt', agents: [toni, mia], text: 'ship the header' });
    });
  });

  it('plain text → the chip target (the seat by default)', () => {
    expect(parseComposer('what is everyone on?', ctx)).toEqual({ kind: 'prompt', agents: [pm], text: 'what is everyone on?' });
    expect(parseComposer('hi', { ...ctx, chip: rex })).toEqual({ kind: 'prompt', agents: [rex], text: 'hi' });
    expect(parseComposer('hi', { ...ctx, chip: null, seat: null })).toEqual({ kind: 'none', reason: 'Pick an agent' });
  });

  it('@x resolves alias → name → id; duplicates collapse', () => {
    expect(findAgent('toni', ctx.agents)).toBe(toni);
    expect(findAgent('@codex-be', ctx.agents)).toBe(rex);
    expect(findAgent('id-pm', ctx.agents)).toBe(pm);
    expect(parseComposer('@toni @frontend hi', ctx)).toEqual({ kind: 'prompt', agents: [toni, mia], text: 'hi' });
  });

  it('@all broadcasts, @person messages a person, mixing is refused', () => {
    expect(parseComposer('@all standup in 5', ctx)).toEqual({ kind: 'broadcast', text: 'standup in 5' });
    expect(parseComposer('@ana can you approve T7?', ctx)).toEqual({ kind: 'message', users: [ana], text: 'can you approve T7?' });
    expect(parseComposer('@ana @toni hi', ctx)).toMatchObject({ kind: 'none' });
    expect(parseComposer('@toni', ctx)).toEqual({ kind: 'none', reason: 'Add a message after the @mention' });
  });

  it('an unknown @mention goes to the seat unchanged', () => {
    expect(parseComposer('@ghost do it', ctx)).toEqual({ kind: 'prompt', agents: [pm], text: '@ghost do it' });
  });

  it('#release / #kill / #tag / #status', () => {
    expect(parseComposer('#release @mia', ctx)).toEqual({ kind: 'release', agent: mia });
    expect(parseComposer('#kill @rex', ctx)).toEqual({ kind: 'kill', agent: rex });
    expect(parseComposer('#tag @rex backend', ctx)).toEqual({ kind: 'tag', agent: rex, tag: 'backend' });
    expect(parseComposer('#status', ctx)).toEqual({ kind: 'status', seat: pm });
    expect(STATUS_PROMPT).toMatch(/status/i);
    expect(parseComposer('#reserve @toni', ctx)).toEqual({ kind: 'reserve', agent: toni, hours: 4 });
  });

  it('#task with optional agent and deps:#n,#m', () => {
    expect(parseComposer('#task @rex add rate limiting deps:#1,#2', ctx)).toEqual({
      kind: 'task', agent: rex, text: 'add rate limiting', deps: [tasks[0], tasks[1]],
    });
    expect(parseComposer('#task tidy the README [deps:#12]', ctx)).toEqual({ kind: 'task', agent: null, text: 'tidy the README', deps: [tasks[2]] });
  });

  it('#promote #n and #file @x name', () => {
    expect(parseComposer('#promote #1', ctx)).toEqual({ kind: 'promote', task: tasks[0] });
    expect(parseComposer('#file @toni mockup v2.png', ctx)).toEqual({ kind: 'file', agent: toni, name: 'mockup v2.png' });
  });

  it('malformed commands fall back to the seat unchanged (never a half-parsed action)', () => {
    for (const text of ['#reserve @ghost 2h', '#reserve @toni 48h', '#kill', '#promote #99', '#task @ghost x', '#task deps:#99 x deps:#99', '#tag @rex Bad!']) {
      expect(parseComposer(text, ctx), text).toEqual({ kind: 'prompt', agents: [pm], text });
    }
  });

  describe('autocomplete', () => {
    const sctx = { ...ctx, colorFor: () => '#38bdf8', currentTask: (a: Agent) => (a === rex ? 'API limits' : null) };

    it('tokenAt finds the @/# token at the cursor', () => {
      expect(tokenAt('hi @to', 6)).toEqual({ start: 3, token: '@to' });
      expect(tokenAt('#res', 4)).toEqual({ start: 0, token: '#res' });
      expect(tokenAt('mail@x.com', 10)).toBeNull();
      expect(tokenAt('hi there', 8)).toBeNull();
    });

    it('@ → agents (status, persona, current task), groups, people, @all', () => {
      const all = suggestionsFor('@', sctx);
      expect(all.map((s) => s.insert)).toEqual(['@toni', '@mia', '@rex', '@pm', '@frontend', '@ana', '@all']);
      expect(all.find((s) => s.insert === '@toni')?.detail).toBe('idle · frontend lead');
      expect(all.find((s) => s.insert === '@rex')?.detail).toBe('working · API limits');
      expect(all.find((s) => s.insert === '@frontend')?.detail).toBe('group · 2 agents');
      expect(suggestionsFor('@to', sctx).map((s) => s.insert)).toEqual(['@toni']);
      expect(suggestionsFor('@codex', sctx).map((s) => s.insert)).toEqual(['@rex']); // by name, inserts the alias
    });

    it('# → commands; # + digits → open tasks only', () => {
      expect(suggestionsFor('#', sctx).map((s) => s.insert)).toContain('#reserve');
      expect(suggestionsFor('#re', sctx).map((s) => s.insert)).toEqual(['#reserve', '#release', '#review']);
      expect(suggestionsFor('#1', sctx).map((s) => s.insert)).toEqual(['#12']); // #1 is done
      expect(suggestionsFor('#2', sctx)).toEqual([{ insert: '#2', label: '#2', detail: 'pending · leases' }]);
    });
  });
});
