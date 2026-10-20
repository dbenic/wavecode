import { Fragment, useCallback, useEffect, useState } from 'react';
import { apiGet } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent } from '../types';
import { ModelEditor } from './ModelSwitch';

function pinLabel(a: Agent): string {
  if (!a.model && !a.effort) return 'none (CLI default)';
  return `${a.model ?? 'default'}${a.effort ? ` ${a.effort}` : ''}`;
}

/**
 * Settings → Models: every agent on one screen — what is pinned, what the CLI
 * says it runs, whether they disagree — with a MODEL button per row. The
 * daemon applies a change live (Claude), by a quick restart that resumes the
 * conversation (Codex), or when the agent is next idle; a drifted pin is
 * reapplied by the guard within a minute of the agent going idle.
 */
export default function ModelsPanel() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<Agent[]>('/agents')
      .then((list) => setAgents((list ?? []).filter((a) => !a.name.startsWith('login-'))))
      .catch((e) => setError((e as Error).message || 'agents unavailable'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type === 'agent.updated' || event.type === 'agent.model_applied' || event.type === 'agent.runtime_relaunched' || event.type === 'agent.status_changed' || event.type === 'agent.spawned' || event.type === 'agent.killed') load();
  }, [load]);
  useSSE(handleSSE);

  const rows = (agents ?? []).slice().sort((a, b) => (a.runtime === b.runtime ? a.name.localeCompare(b.name) : a.runtime.localeCompare(b.runtime)));
  const mismatches = rows.filter((a) => a.model_mismatch).length;

  return (
    <section className="rounded-lg border border-slate-800/50 bg-slate-900/50 overflow-hidden" data-testid="models-panel">
      <div className="px-4 py-3 border-b border-slate-800/50 flex items-center justify-between">
        <h2 className="text-xs font-bold tracking-[0.2em] text-slate-300 uppercase">Models · every agent</h2>
        <span className="text-[10px] text-slate-500">{mismatches > 0 ? `${mismatches} running something other than their pin` : 'pinned agents match what they run'}</span>
      </div>
      <div className="p-4 space-y-2 text-[11px]">
        {error && <p className="text-red-400">{error}</p>}
        {note && <p className="text-indigo-300" data-testid="models-note">{note} <button onClick={() => setNote(null)} className="text-slate-500">×</button></p>}
        {!agents ? (
          <p className="text-[10px] text-slate-600 animate-pulse">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-slate-600">No agents.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="models-table">
              <thead className="text-[9px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-2 py-1.5">Agent</th>
                  <th className="text-left px-2 py-1.5">CLI</th>
                  <th className="text-left px-2 py-1.5">Pinned</th>
                  <th className="text-left px-2 py-1.5">Running</th>
                  <th className="text-left px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {rows.map((a) => (
                  <Fragment key={a.id}>
                  <tr data-testid={`model-row-${a.name}`} className={a.model_mismatch ? 'bg-amber-950/20' : ''}>
                    <td className="px-2 py-1.5 font-mono text-slate-200">{a.alias ? `@${a.alias}` : a.name}{a.alias && <span className="ml-1 text-[9px] text-slate-500">{a.name}</span>}{a.profile && <span className="ml-1 text-[9px] text-slate-600">· {a.profile}</span>}</td>
                    <td className="px-2 py-1.5 text-slate-400">{a.runtime}</td>
                    <td className="px-2 py-1.5"><span className={a.model || a.effort ? 'text-indigo-200' : 'text-slate-500'}>{pinLabel(a)}</span></td>
                    <td className="px-2 py-1.5">
                      {a.live_model ? (
                        <span className={a.model_mismatch ? 'text-amber-200' : 'text-emerald-200'}>{a.live_model.label}{a.live_model.effort ? ` ${a.live_model.effort}` : ''}{a.model_mismatch ? ' ≠ pin' : ''}</span>
                      ) : <span className="text-slate-600">{a.runtime === 'claude-code' ? 'not shown by the CLI' : '—'}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-slate-500">{a.status}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        onClick={() => setEditing(editing === a.id ? null : a.id)}
                        className={`rounded border px-1.5 py-px text-[10px] font-semibold tracking-wider ${editing === a.id ? 'border-indigo-500/60 bg-indigo-950/60 text-indigo-200' : 'border-slate-700 text-slate-300 hover:bg-slate-800'}`}
                        title="Change the model this agent runs on"
                      >
                        MODEL
                      </button>
                    </td>
                  </tr>
                  {editing === a.id && (
                    <tr data-testid={`model-editor-row-${a.name}`}>
                      <td colSpan={6} className="px-3 py-2 bg-slate-950/60">
                        <ModelEditor agent={a} onApplied={(next, n) => { setNote(`${next.name}: ${n}`); setEditing(null); load(); }} onCancel={() => setEditing(null)} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-slate-600">An agent with no pin follows its CLI's own settings, which <span className="font-mono">/model</span> in the pane rewrites. Pin the ones that must stay put; the daemon then keeps them there.</p>
      </div>
    </section>
  );
}
