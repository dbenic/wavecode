import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { Agent, EffortLevel, ModelCatalogue, ModelSwitchResponse } from '../types';

/**
 * The MODEL button on an agent: pick from what the CLI itself offers (Codex's
 * own list on this login, the Claude models), choose an effort, APPLY. The
 * daemon makes the running CLI use it (live for Claude, a quick restart that
 * resumes the conversation for Codex) or waits for the agent to go idle.
 */
export default function ModelSwitch({ agent, onApplied }: { agent: Agent; onApplied: (next: Agent, note: string) => void }) {
  const [open, setOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const [model, setModel] = useState(agent.model ?? '');
  const [effort, setEffort] = useState<string>(agent.effort ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || catalogue) return;
    apiGet<ModelCatalogue>(`/agents/${agent.id}/models`)
      .then((c) => {
        setCatalogue(c);
        if (!agent.model && c.models[0] && !c.free_text) setModel(agent.runtime_defaults?.model ?? c.models[0].id);
      })
      .catch((e) => setError((e as Error).message || 'could not list models'));
  }, [open, catalogue, agent.id, agent.model, agent.runtime_defaults]);

  const efforts: EffortLevel[] = catalogue?.models.find((m) => m.id === model)?.efforts ?? [];

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: { model?: string | null; effort?: EffortLevel | null } = { model: model.trim() || null };
      if (efforts.length > 0) body.effort = (effort || null) as EffortLevel | null;
      const r = await apiPost<ModelSwitchResponse>(`/agents/${agent.id}/model`, body);
      onApplied(r.agent, r.note);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message || 'model change failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="relative inline-flex" data-testid="model-switch">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-slate-700 px-1.5 py-px text-[10px] font-semibold tracking-wider text-slate-300 hover:bg-slate-800"
        title="Change the model this agent runs on"
      >
        MODEL
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-72 rounded border border-slate-700 bg-slate-950 p-3 shadow-xl space-y-2 text-[11px] normal-case" data-testid="model-switch-panel">
          {!catalogue && !error && <p className="text-slate-500 animate-pulse">listing models…</p>}
          {catalogue && (
            <>
              {catalogue.free_text ? (
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id" aria-label="Model" className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-slate-200" />
              ) : (
                <select value={model} onChange={(e) => { setModel(e.target.value); setEffort(''); }} aria-label="Model" className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200">
                  {catalogue.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.id !== m.label ? ` (${m.id})` : ''}</option>)}
                </select>
              )}
              {efforts.length > 0 && (
                <select value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Effort" className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-200">
                  <option value="">effort: CLI default</option>
                  {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              )}
              <p className="text-[10px] text-slate-500">
                {agent.runtime === 'codex' ? 'Codex restarts and resumes its conversation.' : agent.runtime === 'claude-code' ? 'Applied live with /model.' : 'Applies on the next relaunch.'}
                {agent.status === 'working' ? ' The agent is working: applied when idle.' : ''}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-300">cancel</button>
                <button onClick={() => void apply()} disabled={busy || !model.trim()} className="rounded border border-indigo-500/50 bg-indigo-950/60 px-2 py-0.5 font-semibold tracking-wider text-indigo-200 hover:bg-indigo-900/60 disabled:opacity-40">{busy ? '…' : 'APPLY'}</button>
              </div>
            </>
          )}
          {error && <p className="text-red-400">{error}</p>}
        </div>
      )}
    </span>
  );
}
