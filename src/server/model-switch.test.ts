import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-models-'));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    runtimes: {
      codex: { command: 'codex', idle_pattern: '^>', model_flag: '-m', effort_flag: '-c model_reasoning_effort=', env: { CODEX_HOME: '{profile_dir}/codex' } },
      'claude-code': { command: 'claude', idle_pattern: '❯', model_flag: '--model' },
      grok: { command: 'grok', idle_pattern: '>' },
    },
    profiles: { ana: {} },
    paths: { profiles_root: tmp },
  })),
}));
vi.mock('./profiles.js', () => ({
  resolveProfileEnv: vi.fn((runtime: string, profile: string | null) => ({ ok: true, data: runtime === 'codex' && profile ? { CODEX_HOME: path.join(tmp, profile, 'codex') } : {} })),
}));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./tmux.js', () => ({ sendTextAndEnter: vi.fn(), sendRawKey: vi.fn(), hasSession: vi.fn(() => true) }));
vi.mock('./output-watcher.js', () => ({ getLiveModel: vi.fn(() => null) }));
vi.mock('./runtime-liveness.js', () => ({
  getRuntimeState: vi.fn(async () => 'alive'),
  ensureRuntimeAlive: vi.fn(async () => ({ ok: true, data: { relaunched: true } })),
  relaunchRuntime: vi.fn(async () => ({ ok: true, data: { sent: true } })),
  waitForRuntimeSettled: vi.fn(async () => true),
  noteRuntimeAlive: vi.fn(),
}));

describe('model switch', () => {
  let dbPath: string;
  beforeEach(async () => {
    dbPath = path.join(tmp, `t-${Date.now()}-${Math.random()}.db`);
    const db = await import('./db.js');
    db.initDb(dbPath);
    const ms = await import('./model-switch.js');
    ms.resetModelSwitchForTest();
    const bus = await import('./event-bus.js');
    bus.resetEventListenersForTest();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    const { resetDbForTest } = await import('./db.js');
    resetDbForTest();
  });

  it('lists the models Codex cached on the agent profile, with the efforts each accepts', async () => {
    const { listModels, parseCodexModelsCache } = await import('./model-switch.js');
    fs.mkdirSync(path.join(tmp, 'ana', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ana', 'codex', 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }] },
      { slug: 'bad slug!', display_name: 'nope' },
    ] }));
    const cat = listModels({ runtime: 'codex', profile: 'ana' });
    expect(cat.source).toBe('codex_cache');
    expect(cat.models).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'high', 'ultra'] },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['medium', 'max'] },
    ]);
    expect(listModels({ runtime: 'codex', profile: 'nobody' })).toMatchObject({ free_text: true, source: 'none', models: [] });
    expect(listModels({ runtime: 'claude-code', profile: null }).models.map((m) => m.id)).toContain('claude-fable-5-1');
    expect(listModels({ runtime: 'grok', profile: null }).free_text).toBe(true);
    expect(parseCodexModelsCache('not json')).toEqual([]);
  });

  it('Claude Code gets /model live when idle; a working agent gets it when it goes idle', async () => {
    const db = await import('./db.js');
    const tmux = await import('./tmux.js');
    const { switchModel } = await import('./model-switch.js');
    const made = db.insertAgent({ name: 'cc', runtime: 'claude-code', tmux_session: 'wc-cc', workspace: null, mode: 'spawned', status: 'idle' });
    if (!made.ok) throw new Error(made.error);
    const r = await switchModel(made.data, { model: 'claude-fable-5-1' });
    expect(r.ok && r.data.applied).toBe('live');
    expect(tmux.sendTextAndEnter).toHaveBeenCalledWith('wc-cc', '/model claude-fable-5-1');
    expect(db.getAgent(made.data.id).ok && (db.getAgent(made.data.id) as { data: { model: string } }).data.model).toBe('claude-fable-5-1');

    vi.mocked(tmux.sendTextAndEnter).mockClear();
    db.updateAgentStatus(made.data.id, 'working');
    const busy = db.getAgent(made.data.id);
    if (!busy.ok) throw new Error('agent');
    const deferred = await switchModel(busy.data, { model: 'claude-opus-5-5' });
    expect(deferred.ok && deferred.data.applied).toBe('when_idle');
    expect(tmux.sendTextAndEnter).not.toHaveBeenCalled();
    const bus = await import('./event-bus.js');
    bus.emit('agent.status_changed', 'agent', made.data.id, { status: 'idle' });
    await new Promise((r) => setTimeout(r, 20));
    expect(tmux.sendTextAndEnter).toHaveBeenCalledWith('wc-cc', '/model claude-opus-5-5');
  });

  it('Codex is asked to quit, then relaunched with the pin and resumes; an unknown effort is refused', async () => {
    const db = await import('./db.js');
    const tmux = await import('./tmux.js');
    const live = await import('./runtime-liveness.js');
    const { switchModel } = await import('./model-switch.js');
    const made = db.insertAgent({ name: 'cx', runtime: 'codex', tmux_session: 'wc-cx', workspace: null, mode: 'spawned', status: 'idle' });
    if (!made.ok) throw new Error(made.error);
    let asks = 0;
    vi.mocked(live.getRuntimeState).mockImplementation(async () => (asks++ === 0 ? 'alive' : 'dead'));
    const r = await switchModel(made.data, { model: 'gpt-6-astra', effort: 'high' });
    expect(r.ok && r.data.applied).toBe('relaunched');
    expect(tmux.sendTextAndEnter).toHaveBeenCalledWith('wc-cx', '/quit');
    expect(live.relaunchRuntime).toHaveBeenCalledWith(expect.objectContaining({ id: made.data.id, model: 'gpt-6-astra', effort: 'high' }), 'manual');
    const bad = await switchModel(made.data, { model: 'gpt-6-astra', effort: 'extreme' as never });
    expect(bad.ok).toBe(false);
  });

  it('the guard reapplies a pin to an idle agent whose CLI shows another model, once per backoff', async () => {
    const db = await import('./db.js');
    const tmux = await import('./tmux.js');
    const live = await import('./runtime-liveness.js');
    const watcher = await import('./output-watcher.js');
    const { guardPinsOnce, pinDiffersFromLive, stopModelGuard } = await import('./model-switch.js');
    stopModelGuard();
    const made = db.insertAgent({ name: 'scout', runtime: 'codex', tmux_session: 'wc-scout', workspace: null, mode: 'spawned', status: 'idle', model: 'gpt-6-astra', effort: 'high' } as never);
    if (!made.ok) throw new Error(made.error);
    expect(pinDiffersFromLive({ model: 'gpt-6-astra', effort: 'high' }, { label: 'GPT-6-Astra', model: 'gpt-6-astra', effort: 'high' })).toBe(false);
    expect(pinDiffersFromLive({ model: 'gpt-6-astra', effort: 'high' }, { label: 'GPT-6.1-Sol', model: 'gpt-6.1-sol', effort: 'ultra' })).toBe(true);
    expect(pinDiffersFromLive({ model: null, effort: null }, { label: 'GPT-6.1-Sol', model: 'gpt-6.1-sol', effort: 'ultra' })).toBe(false); // nothing pinned
    expect(pinDiffersFromLive({ model: 'gpt-6-astra', effort: 'high' }, null)).toBe(false); // Claude shows no footer
    vi.mocked(watcher.getLiveModel).mockReturnValue({ label: 'GPT-6.1-Sol', model: 'gpt-6.1-sol', effort: 'ultra' });
    let asks = 0;
    vi.mocked(live.getRuntimeState).mockImplementation(async () => (asks++ % 2 === 0 ? 'alive' : 'dead'));
    const t0 = 5_000_000;
    expect(await guardPinsOnce(t0)).toEqual([made.data.id]);
    expect(tmux.sendTextAndEnter).toHaveBeenCalledWith('wc-scout', '/quit');
    expect(live.relaunchRuntime).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra', effort: 'high' }), 'manual');
    expect(await guardPinsOnce(t0 + 60_000)).toEqual([]); // backoff: not again within ten minutes
    expect(await guardPinsOnce(t0 + 11 * 60_000)).toEqual([made.data.id]);
  });
});
