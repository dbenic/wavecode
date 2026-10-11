import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { Agent, DeskDetail, DeskItemLinked, DeskListResponse } from '../types';

const STATUS_CLS: Record<string, string> = {
  new: 'text-slate-300 border-slate-600',
  accepted: 'text-emerald-300 border-emerald-500/40',
  implementing: 'text-amber-300 border-amber-500/40',
  waiting_on_requester: 'text-orange-300 border-orange-500/40',
  in_review: 'text-violet-300 border-violet-500/40',
  shipped: 'text-slate-500 border-slate-700',
};

const field = 'px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-[10px] text-slate-300 font-mono focus:outline-none focus:border-slate-600';

function when(iso: string | null): string {
  return iso ? iso.replace('T', ' ').slice(5, 16) : '';
}

/**
 * The Product Desk board inside the Tasks page: open requests with their status, target
 * version, attachments and what WaveCode knows about each (lanes frozen for that desk,
 * tasks carrying it, their state). A person hands a request to an agent from here.
 */
export default function DeskPanel({ agents }: { agents: Agent[] }) {
  const [data, setData] = useState<DeskListResponse | null>(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<DeskDetail | null>(null);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const fetchList = useCallback((refresh = false) => {
    apiGet<DeskListResponse>(`/desk${all ? '?all=1' : ''}${refresh ? (all ? '&' : '?') + 'refresh=1' : ''}`)
      .then(setData)
      .catch((e) => { setError((e as Error).message || 'desk unreachable'); setData((d) => d ?? { enabled: true, items: [], state: { enabled: true, cached_at: null, error: null } }); });
  }, [all]);

  useEffect(() => { fetchList(); }, [fetchList]);

  const show = async (id: number) => {
    if (open === id) { setOpen(null); setDetail(null); return; }
    setOpen(id);
    setDetail(null);
    try {
      setDetail(await apiGet<DeskDetail>(`/desk/${id}`));
    } catch (e) {
      setError((e as Error).message || 'detail unavailable');
    }
  };

  const createTask = async (item: DeskItemLinked) => {
    const agentId = pick[item.id] ?? '';
    if (!agentId) return;
    const note = window.prompt(`Hand desk #${item.id} to the agent — note for it (optional):`);
    if (note === null) return;
    setActing(`task:${item.id}`);
    setError(null);
    try {
      await apiPost(`/desk/${item.id}/task`, { agent_id: agentId, note: note.trim() });
      fetchList();
    } catch (e) {
      setError((e as Error).message || 'task not created');
    } finally {
      setActing(null);
    }
  };

  if (data && !data.enabled) return null;
  const items = data?.items ?? [];

  return (
    <section className="mb-4 rounded-lg border border-cyan-500/25 bg-cyan-950/10" data-testid="desk-panel">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <button onClick={() => setCollapsed((v) => !v)} className="text-[10px] font-semibold tracking-wider text-cyan-300">
          {collapsed ? '▸' : '▾'} PRODUCT DESK
        </button>
        <span className="text-[10px] text-slate-500">{items.length} {all ? 'request' : 'open request'}{items.length === 1 ? '' : 's'}{data?.state.cached_at ? ` · read ${when(data.state.cached_at)}` : ''}</span>
        {data?.state.error && <span className="text-[10px] text-red-400" title={data.state.error}>desk error — showing the last good read</span>}
        <span className="ml-auto flex items-center gap-2 text-[10px]">
          <label className="flex items-center gap-1 text-slate-400 cursor-pointer">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> all statuses
          </label>
          <button onClick={() => fetchList(true)} className="px-2 py-0.5 rounded border border-slate-700 text-slate-300 hover:bg-slate-800">REFRESH</button>
        </span>
      </div>
      {error && <p className="px-3 pb-2 text-[10px] text-red-400">{error}</p>}
      {!collapsed && (
        <div className="overflow-x-auto border-t border-cyan-500/15">
          <table className="w-full text-[11px]" data-testid="desk-table">
            <thead className="bg-slate-900/60 text-[9px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-3 py-1.5">#</th>
                <th className="text-left px-3 py-1.5">Request</th>
                <th className="text-left px-3 py-1.5">Status</th>
                <th className="text-left px-3 py-1.5">Target</th>
                <th className="text-left px-3 py-1.5">Files</th>
                <th className="text-left px-3 py-1.5">In WaveCode</th>
                <th className="text-right px-3 py-1.5">Hand to</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {items.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-3 text-[11px] text-slate-600">{data ? 'Nothing open on the desk.' : 'Loading…'}</td></tr>
              )}
              {items.map((item) => {
                const openTask = item.links.tasks.find((t) => t.status === 'pending' || t.status === 'running' || t.status === 'blocked');
                const lanes = item.links.lanes.filter((l) => l.status === 'open' || l.status === 'stale');
                return (
                  <>
                    <tr key={item.id} className="align-top" data-testid={`desk-${item.id}`}>
                      <td className="px-3 py-2 font-mono text-slate-400">{item.id}</td>
                      <td className="px-3 py-2 max-w-[26rem]">
                        <button onClick={() => void show(item.id)} className="text-left text-slate-200 hover:text-white">{item.title}</button>
                        <div className="text-[9px] text-slate-600">{[item.area, item.priority ? `prio ${item.priority}` : null, item.requester_name, when(item.updated_at)].filter(Boolean).join(' · ')}</div>
                        {item.last_summary && <div className="text-[10px] text-slate-500 line-clamp-1" title={item.last_summary}>{item.last_agent ? `@${item.last_agent}: ` : ''}{item.last_summary}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${STATUS_CLS[item.status] ?? 'text-slate-400 border-slate-700'}`}>{item.status.replace(/_/g, ' ').toUpperCase()}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-400">{item.target_version ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{item.file_count || '—'}</td>
                      <td className="px-3 py-2 text-[10px]">
                        {item.links.tasks.map((t) => (
                          <div key={t.id} className={t.status === 'done' ? 'text-slate-500' : 'text-cyan-300'}>task #{t.num ?? '?'} · {t.status}{t.agent_name ? ` · @${t.agent_name}` : ''}</div>
                        ))}
                        {lanes.map((l) => (
                          <div key={l.sha} className="font-mono text-slate-400">{l.sha.slice(0, 8)} · {(l.verdict ?? 'no verdict').replace('-', ' ')}{l.status === 'stale' ? ' · stale' : ''}</div>
                        ))}
                        {item.links.tasks.length === 0 && lanes.length === 0 && <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {openTask ? (
                          <span className="text-[10px] text-slate-500">with @{openTask.agent_name ?? '?'}</span>
                        ) : (
                          <>
                            <select value={pick[item.id] ?? ''} onChange={(e) => setPick((p) => ({ ...p, [item.id]: e.target.value }))} className={field} aria-label={`Agent for desk ${item.id}`}>
                              <option value="">agent…</option>
                              {agents.map((a) => <option key={a.id} value={a.id}>@{a.alias ?? a.name} · {a.status}</option>)}
                            </select>
                            <button onClick={() => void createTask(item)} disabled={acting !== null || !pick[item.id]} className="ml-1.5 px-2 py-1 rounded border border-cyan-500/40 text-[10px] font-semibold tracking-wider text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40">
                              {acting === `task:${item.id}` ? '...' : 'CREATE TASK'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {open === item.id && (
                      <tr key={`${item.id}-detail`} data-testid={`desk-detail-${item.id}`}>
                        <td colSpan={7} className="px-3 py-3 bg-slate-950/60">
                          {!detail ? (
                            <p className="text-[10px] text-slate-600 animate-pulse">Loading the card…</p>
                          ) : (
                            <div className="grid gap-3 md:grid-cols-2 text-[11px]">
                              <div className="space-y-2">
                                <p className="text-[9px] uppercase tracking-wider text-slate-500">Messages</p>
                                {detail.messages.length === 0 && <p className="text-slate-600">No messages.</p>}
                                {detail.messages.slice(-4).map((m) => (
                                  <div key={m.id} className="rounded border border-slate-800/60 px-2 py-1.5">
                                    <div className="text-[9px] text-slate-500">{m.direction ?? ''} · {m.from_name ?? m.from_email ?? ''} · {when(m.received_at)}</div>
                                    {m.subject && <div className="text-slate-300">{m.subject}</div>}
                                    <div className="text-slate-400 whitespace-pre-wrap line-clamp-6">{m.body_text}</div>
                                  </div>
                                ))}
                                {detail.request.note && <p className="text-[10px] text-slate-400"><span className="text-slate-500">Staff note:</span> {detail.request.note}</p>}
                              </div>
                              <div className="space-y-2">
                                <p className="text-[9px] uppercase tracking-wider text-slate-500">Attachments (originals stay in production)</p>
                                {detail.files.length === 0 && <p className="text-slate-600">None.</p>}
                                {detail.files.map((f) => (
                                  <div key={f.id} className="flex items-center gap-2">
                                    <a href={`/api/desk/files/${f.id}`} target="_blank" rel="noopener" className="text-sky-300 underline underline-offset-2">{f.name}</a>
                                    <span className="text-[9px] text-slate-600">{f.mime ?? ''}{f.size ? ` · ${Math.round(f.size / 1024)}K` : ''}</span>
                                  </div>
                                ))}
                                <p className="text-[9px] uppercase tracking-wider text-slate-500 mt-2">History</p>
                                {detail.events.slice(-6).map((e) => (
                                  <div key={e.id} className="text-[10px] text-slate-500">
                                    {when(e.created_at)} · {e.kind ?? ''}{e.to_status ? ` → ${e.to_status}` : ''}{e.version ? ` v${e.version}` : ''}{e.release_sha ? ` ${e.release_sha.slice(0, 8)}` : ''}{e.user_name ? ` · ${e.user_name}` : ''}{e.body ? ` — ${e.body.slice(0, 120)}` : ''}
                                  </div>
                                ))}
                                {detail.request.candidate_sha && <p className="text-[10px] text-violet-300">candidate {detail.request.candidate_sha.slice(0, 8)}</p>}
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
