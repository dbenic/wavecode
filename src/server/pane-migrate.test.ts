import { beforeEach, describe, expect, it, vi } from 'vitest';

const agents = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./db.js', () => ({ listAgents: vi.fn(() => agents) }));
vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./login-seats.js', () => ({ isLoginSeat: vi.fn((a: { tmux_session: string }) => a.tmux_session.startsWith('wc-login-')) }));
vi.mock('./runtime-liveness.js', () => ({ relaunchRuntime: vi.fn(async () => ({ ok: true, data: { sent: true } })) }));
const alt = vi.hoisted(() => new Map<string, string>());
vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(async (s: string) => s !== 'wc-gone'),
  tmuxExecSafe: vi.fn(async (args: string[]) => (args[0] === 'display-message' ? alt.get(args[2]) ?? '0' : '')),
  respawnPane: vi.fn(async () => true),
  disableAlternateScreen: vi.fn(async () => undefined),
}));

describe('pane migration', () => {
  beforeEach(() => { vi.clearAllMocks(); agents.length = 0; alt.clear(); });

  it('recreates the pane of each idle agent still on the alternate screen and relaunches it; skips working agents, seats and dead sessions', async () => {
    agents.push(
      { id: 'a1', name: 'codex1', status: 'idle', tmux_session: 'wc-codex1' },
      { id: 'a2', name: 'claude1', status: 'working', tmux_session: 'wc-claude1' },
      { id: 'a3', name: 'codex8', status: 'idle', tmux_session: 'wc-codex8' },
      { id: 'a4', name: 'login-x-codex', status: 'idle', tmux_session: 'wc-login-x-codex' },
      { id: 'a5', name: 'ghost', status: 'idle', tmux_session: 'wc-gone' },
    );
    alt.set('wc-codex1', '1'); alt.set('wc-claude1', '1'); alt.set('wc-codex8', '0'); alt.set('wc-login-x-codex', '1'); alt.set('wc-gone', '1');
    const { migrateAlternateScreenPanes } = await import('./pane-migrate.js');
    const tmux = await import('./tmux.js');
    const live = await import('./runtime-liveness.js');
    expect(await migrateAlternateScreenPanes()).toEqual(['codex1']);
    expect(tmux.respawnPane).toHaveBeenCalledTimes(1);
    expect(tmux.respawnPane).toHaveBeenCalledWith('wc-codex1');
    expect(live.relaunchRuntime).toHaveBeenCalledWith(expect.objectContaining({ name: 'codex1' }), 'manual');
  });
});
