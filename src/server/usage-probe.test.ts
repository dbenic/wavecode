import { describe, expect, it, vi } from 'vitest';

vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('./tmux.js', () => ({ sendTextAndEnter: vi.fn(), capturePane: vi.fn(), sendRawKey: vi.fn() }));
vi.mock('./runtime-liveness.js', () => ({ getRuntimeState: vi.fn(() => 'alive') }));
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ usage: { probe_interval_min: 15 } })) }));

import { parseClaudeUsage, parseCodexStatus, pickProbeTargets, resetUsageProbeForTest, summarize } from './usage-probe.js';
import type { Agent } from './db.js';

const CODEX = `/status
  >_ OpenAI Codex (v0.160.1)
  Model:               GPT-6-Astra (reasoning high, summaries auto)
  Account:             Pro 200
  Context window:      12% left (230K used / 258K)
  Weekly limit:        [█████████████░░░░░░░] 65% left (resets 5:58 AM on 14 Oct)
  Credits:             2625 credits
› Ask Codex to do anything`;

const CLAUDE = `   Settings  Status   Config   Usage   Stats
   Current session
   ████▌                                              9% used
   Resets 10:49am (UTC)
   Current week (all models)
   ████████▌                                          17% used
   Resets Oct 14, 1:59am (UTC)
   Current week (Fable)
                                                      0% used
   Resets Oct 14, 2am (UTC)
   What's contributing to your limits usage?
   Usage credits
   ██████▎                                            12% used
   €88.47 / €700.00 spent · Resets Nov 1 (UTC)
   Esc to cancel`;

describe('usage parsers', () => {
  it('Codex /status → weekly left, context, credits; summary for the badge', () => {
    const m = parseCodexStatus(CODEX);
    expect(m).toEqual([
      { label: 'weekly', left_pct: 65, used_pct: 35, resets: '5:58 AM on 14 Oct' },
      { label: 'context', left_pct: 12, used_pct: 88, resets: null },
      { label: 'credits', left_pct: null, used_pct: null, resets: null, extra: '2625 credits' },
    ]);
    expect(summarize(m)).toBe('65% left · resets 14 Oct 5:58 AM');
  });

  it('Claude /usage → session (5h), weekly, per-model, credits; summary shows weekly left + 5h used', () => {
    const m = parseClaudeUsage(CLAUDE);
    expect(m).toEqual([
      { label: '5h', left_pct: 91, used_pct: 9, resets: '10:49am (UTC)' },
      { label: 'weekly', left_pct: 83, used_pct: 17, resets: 'Oct 14, 1:59am (UTC)' },
      { label: 'weekly-model', left_pct: 100, used_pct: 0, resets: 'Oct 14, 2am (UTC)' },
      { label: 'credits', left_pct: 88, used_pct: 12, resets: 'Nov 1 (UTC)', extra: '€88.47 / €700.00' },
    ]);
    expect(summarize(m)).toBe('83% left · resets Oct 14 1:59am · 5h 9% used');
    expect(parseClaudeUsage('❯ \n  ⏵⏵ bypass permissions on')).toEqual([]);
  });
});

describe('pickProbeTargets', () => {
  const agent = (over: Partial<Agent>): Agent => ({ id: over.name!, name: over.name!, runtime: 'codex', tmux_session: 'x', workspace: null, mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', profile: null, ...over } as Agent);
  it('one idle agent per (runtime, profile), only runtimes with a status screen, respecting the interval', () => {
    resetUsageProbeForTest();
    const agents = [
      agent({ name: 'codex1', profile: 'denis' }), agent({ name: 'codex2', profile: 'denis' }),
      agent({ name: 'codex-antonio', profile: 'antonio', status: 'working' }),
      agent({ name: 'claude1', runtime: 'claude-code', profile: 'denis' }),
      agent({ name: 'claude2', runtime: 'claude-code', profile: 'pool' }),
      agent({ name: 'grok1', runtime: 'grok', profile: 'denis' }),
    ];
    expect(pickProbeTargets(agents).map((a) => a.name)).toEqual(['codex1', 'claude1', 'claude2']);
  });
});
