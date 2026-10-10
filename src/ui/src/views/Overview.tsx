import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Board, ChatAction, ChatTurn, FixRow, OverlordReport, OverviewResponse, Recommendation } from '../types';

function ago(min: number | null): string {
  if (min === null) return '';
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

const STATUS_CLS: Record<string, string> = {
  working: 'text-amber-300 border-amber-500/40',
  idle: 'text-emerald-300 border-emerald-500/40',
  error: 'text-red-300 border-red-500/40',
};

const KIND_CLS: Record<string, string> = {
  promote: 'text-emerald-300 border-emerald-500/40',
  stage: 'text-sky-300 border-sky-500/40',
  reject: 'text-red-300 border-red-500/40',
  nudge: 'text-amber-300 border-amber-500/40',
  reassign: 'text-violet-300 border-violet-500/40',
  refreeze: 'text-amber-300 border-amber-500/40',
  fix: 'text-orange-300 border-orange-500/40',
  info: 'text-slate-400 border-slate-600/40',
};

function budgetCls(pct: number | null): string {
  if (pct === null) return 'text-slate-600';
  if (pct < 10) return 'text-red-300';
  if (pct < 30) return 'text-amber-300';
  return 'text-emerald-300';
}

const field = 'px-2 py-1 rounded border border-slate-800/60 bg-slate-950/50 text-[10px] text-slate-300 font-mono focus:outline-none focus:border-slate-600';

/**
 * Chat with the overlord first, then its latest report and release plan, then the data:
 * open fixes (assign an agent, see who is on it), the attention list, the agent board with
 * budget, and the lanes.
 */
export default function Overview() {
  const navigate = useNavigate();
  const [board, setBoard] = useState<Board | null>(null);
  const [report, setReport] = useState<OverlordReport | null>(null);
  const [overlord, setOverlord] = useState<OverviewResponse['overlord'] | null>(null);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignPick, setAssignPick] = useState<Record<string, string>>({});
  const chatEnd = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    apiGet<OverviewResponse>('/overview')
      .then((r) => { setBoard(r.board); setReport(r.report); setOverlord(r.overlord); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);
  const fetchChat = useCallback(() => {
    apiGet<ChatTurn[]>('/overview/chat').then(setChat).catch(() => setChat([]));
  }, []);

  useEffect(() => { fetchData(); fetchChat(); }, [fetchData, fetchChat]);
  useEffect(() => { chatEnd.current?.scrollIntoView?.({ block: 'nearest' }); }, [chat.length]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type === 'overlord.chat') fetchChat();
    else if (/^(overlord|release|review|run|agent|task)\./.test(event.type)) fetchData();
  }, [fetchData, fetchChat]);
  useSSE(handleSSE);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setActing(key);
    setError(null);
    try {
      await fn();
      fetchData();
    } catch (e) {
      setError((e as Error).message || 'action failed');
    } finally {
      setActing(null);
    }
  };

  const ask = async () => {
    const message = draft.trim();
    if (!message || asking) return;
    setAsking(true);
    setError(null);
    setDraft('');
    setChat((c) => [...c, { id: `tmp-${Date.now()}`, created_at: new Date().toISOString(), role: 'user', user_id: null, user_name: 'you', text: message, actions: [] }]);
    try {
      await apiPost('/overview/chat', { message });
      fetchChat();
    } catch (e) {
      setError((e as Error).message || 'the overlord did not answer');
    } finally {
      setAsking(false);
    }
  };

  const runChatAction = (a: ChatAction, key: string) => {
    if (a.kind === 'send' && a.agent_id && a.text) {
      const agentId = a.agent_id;
      const text = a.text;
      if (!window.confirm(`Send this prompt to @${a.agent ?? agentId}?\n\n${text.slice(0, 1500)}${text.length > 1500 ? '…' : ''}`)) return;
      return act(key, () => apiPost(`/agents/${agentId}/send`, { text }));
    }
    if (a.kind === 'assign_fix' && a.agent_id && a.run_id) {
      const body = { run_id: a.run_id, agent_id: a.agent_id };
      return act(key, () => apiPost('/overview/fixes/assign', body));
    }
    if ((a.kind === 'stage' || a.kind === 'promote' || a.kind === 'reject') && a.run_id) {
      const runId = a.run_id;
      if (a.kind === 'promote' && !window.confirm(`Send the PRODUCTION GO for ${a.sha?.slice(0, 8) ?? 'this lane'}?`)) return;
      if (a.kind === 'reject') {
        const reason = window.prompt('Reject — reason:');
        if (reason === null) return;
        return act(key, () => apiPost(`/reviews/${runId}/reject`, { reason: reason.trim() }));
      }
      return act(key, () => apiPost(`/reviews/${runId}/${a.kind}`));
    }
    if (a.kind === 'verify' && a.sha) {
      const sha = a.sha;
      return act(key, () => apiPost('/releases/verify', { sha, note: 'via overlord chat' }));
    }
  };

  const assignFix = (f: FixRow) => {
    const agentId = assignPick[f.run_id] ?? f.author_agent_id ?? '';
    if (!agentId) return;
    return act(`fix-${f.run_id}`, () => apiPost('/overview/fixes/assign', { run_id: f.run_id, agent_id: agentId }));
  };

  const runRecommendation = (r: Recommendation, i: number) => {
    const key = `rec-${i}`;
    if ((r.kind === 'promote' || r.kind === 'stage' || r.kind === 'reject') && r.run_id) {
      const runId = r.run_id;
      if (r.kind === 'promote' && !window.confirm(`Send the PRODUCTION GO for ${r.sha?.slice(0, 8) ?? 'this lane'}?`)) return;
      if (r.kind === 'reject') {
        const reason = window.prompt('Reject — reason:');
        if (reason === null) return;
        return act(key, () => apiPost(`/reviews/${runId}/reject`, { reason: reason.trim() }));
      }
      return act(key, () => apiPost(`/reviews/${runId}/${r.kind}`));
    }
    if (r.kind === 'fix' && r.run_id && r.agent_id) {
      const body = { run_id: r.run_id, agent_id: r.agent_id };
      return act(key, () => apiPost('/overview/fixes/assign', body));
    }
    if (r.kind === 'nudge' && r.agent_id) {
      const agentId = r.agent_id;
      return act(key, () => apiPost(`/agents/${agentId}/send`, { text: `[Overlord] ${r.text}` }));
    }
  };

  const noteFor = (agentId: string) => report?.agents.find((a) => a.id === agentId)?.note ?? null;
  const agentLabel = (id: string | null) => {
    const a = board?.agents.find((x) => x.id === id);
    return a ? `@${a.alias ?? a.name}` : id ? `@${id.slice(-6)}` : '?';
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="sticky top-0 z-40 border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate('/')} className="text-slate-500 hover:text-slate-300 text-sm">&larr;</button>
            <div>
              <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Overview</h1>
              {board && (
                <p className="text-[9px] text-slate-600 tracking-[0.3em] uppercase">
                  {board.counts.working} working &middot; {board.counts.idle} idle{board.counts.error ? ` · ${board.counts.error} error` : ''} &middot; {board.counts.open_lanes} lanes &middot; {board.counts.promotable} promotable &middot; {board.counts.open_fixes} fixes{board.counts.unassigned_fixes ? ` (${board.counts.unassigned_fixes} unassigned)` : ''}
                </p>
              )}
            </div>
          </div>
          {overlord && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className={`rounded px-1.5 py-0.5 border ${overlord.enabled ? 'text-violet-300 border-violet-500/40' : 'text-slate-500 border-slate-700'}`}>
                OVERLORD {overlord.enabled ? overlord.model : 'off'}
              </span>
              {overlord.enabled && (
                <button
                  onClick={() => act('wake', () => apiPost('/overview/wake', {}))}
                  disabled={acting !== null}
                  className="px-2 py-0.5 rounded border border-violet-500/30 text-violet-300 font-semibold tracking-wider hover:bg-violet-500/10 disabled:opacity-40"
                >
                  {acting === 'wake' ? '...' : 'NEW REPORT'}
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {error && <p className="text-[11px] text-red-400 border border-red-500/30 rounded px-3 py-2">{error}</p>}

        {/* 1. Chat with the overlord */}
        <section className="rounded-lg border border-violet-500/25 bg-violet-950/10 p-3 space-y-2" data-testid="overlord-chat">
          <p className="text-[10px] font-semibold tracking-wider text-violet-300">ASK THE OVERLORD</p>
          <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
            {chat.length === 0 && (
              <p className="text-[11px] text-slate-500">Ask what to deploy together, who should take a fix, what is blocked, or where budget runs low. It answers from the board.</p>
            )}
            {chat.map((t) => (
              <div key={t.id} className={`text-[12px] whitespace-pre-wrap rounded px-2.5 py-1.5 ${t.role === 'user' ? 'bg-slate-900/60 text-slate-300' : 'bg-violet-950/30 text-slate-100 border border-violet-500/20'}`}>
                <span className="text-[9px] uppercase tracking-wider text-slate-500 mr-2">{t.role === 'user' ? (t.user_name ?? 'you') : 'overlord'}</span>
                {t.text}
                {t.actions && t.actions.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid={`chat-actions-${t.id}`}>
                    {t.actions.map((a, i) => (
                      <button
                        key={i}
                        onClick={() => runChatAction(a, `chat-${t.id}-${i}`)}
                        disabled={acting !== null}
                        title={a.kind === 'send' && a.text ? a.text : a.label}
                        className="px-2 py-0.5 rounded border border-violet-400/50 bg-violet-500/10 text-[10px] font-semibold tracking-wider text-violet-100 hover:bg-violet-500/25 disabled:opacity-40"
                      >
                        {acting === `chat-${t.id}-${i}` ? '...' : a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {asking && <p className="text-[11px] text-violet-300 animate-pulse">thinking…</p>}
            <div ref={chatEnd} />
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); void ask(); }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={overlord?.enabled ? 'What should go to production today?' : 'Enable the overlord in config.yaml to chat'}
              disabled={!overlord?.enabled || asking}
              className={`${field} flex-1 text-[12px] py-1.5`}
              aria-label="Ask the overlord"
            />
            <button type="submit" disabled={!overlord?.enabled || asking || !draft.trim()} className="px-3 py-1.5 rounded border border-violet-500/40 text-[10px] font-semibold tracking-wider text-violet-200 hover:bg-violet-500/10 disabled:opacity-40">
              ASK
            </button>
          </form>
        </section>

        {!loaded || !board ? (
          <p className="text-[10px] text-slate-600 tracking-[0.3em] uppercase animate-pulse py-16 text-center">Loading…</p>
        ) : (
          <>
            {/* 2. Latest report + release plan */}
            <section className="rounded-lg border border-slate-800/60 bg-slate-900/30 p-3 space-y-2" data-testid="overlord-report">
              <div className="flex items-center justify-between text-[10px]">
                <span className="font-semibold tracking-wider text-slate-300">LATEST REPORT</span>
                {report ? <span className="text-slate-500">{report.created_at.slice(0, 16)} · {report.trigger}</span> : <span className="text-slate-600">no report yet</span>}
              </div>
              {report?.digest && <p className="text-[12px] text-slate-200 whitespace-pre-wrap">{report.digest}</p>}
              {report && report.plan.length > 0 && (
                <div className="space-y-1" data-testid="release-plan">
                  <p className="text-[9px] font-semibold tracking-wider text-slate-500">RELEASE PLAN</p>
                  {report.plan.map((g, i) => (
                    <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
                      <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border uppercase ${g.target === 'production' ? 'text-emerald-300 border-emerald-500/40' : g.target === 'hold' ? 'text-amber-300 border-amber-500/40' : 'text-sky-300 border-sky-500/40'}`}>{g.target}</span>
                      <span className="text-slate-200">{g.title}</span>
                      <span className="font-mono text-[10px] text-slate-500">{g.shas.map((s) => s.slice(0, 8)).join(' → ')}</span>
                      <span className="text-slate-400 basis-full">{g.why}</span>
                    </div>
                  ))}
                </div>
              )}
              {report && report.recommendations.length > 0 && (
                <ul className="space-y-1.5">
                  {report.recommendations.map((r, i) => {
                    const actionable = ((r.kind === 'promote' || r.kind === 'stage' || r.kind === 'reject') && r.run_id) || (r.kind === 'nudge' && r.agent_id) || (r.kind === 'fix' && r.run_id && r.agent_id);
                    return (
                      <li key={i} className="flex items-start gap-2 text-[11px]">
                        <span className={`shrink-0 text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border uppercase ${KIND_CLS[r.kind] ?? KIND_CLS.info}`}>{r.kind}</span>
                        <span className="text-slate-300 flex-1">{r.text}</span>
                        {actionable && (
                          <button
                            onClick={() => runRecommendation(r, i)}
                            disabled={acting !== null}
                            className="shrink-0 px-2 py-0.5 rounded border border-slate-600 text-[9px] font-semibold tracking-wider text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                          >
                            {acting === `rec-${i}` ? '...' : 'DO IT'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {!overlord?.enabled && <p className="text-[10px] text-slate-600">Enable with <code className="text-slate-400">overlord.enabled: true</code> and an LLM key in config.yaml. Everything below works without it.</p>}
            </section>

            {/* 3. Open fixes: nothing stays open without an agent on it */}
            {board.fixes.length > 0 && (
              <section className="rounded-lg border border-orange-500/25 bg-orange-950/10 p-3" data-testid="fixes">
                <p className="text-[10px] font-semibold tracking-wider text-orange-300 mb-1.5">OPEN FIXES</p>
                <ul className="divide-y divide-orange-500/10">
                  {board.fixes.map((f) => (
                    <li key={f.run_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[11px]" data-testid={`fix-${f.sha.slice(0, 8)}`}>
                      <span className="text-slate-200">{f.project ?? ''}{f.desk ? ` Desk #${f.desk}` : ''}</span>
                      <span className="font-mono text-slate-400" title={f.sha}>{f.sha.slice(0, 8)}</span>
                      <span className="text-orange-300 uppercase text-[9px] tracking-wider">{f.reason}</span>
                      <span className="text-slate-500">by {agentLabel(f.author_agent_id)}{f.reviewer ? ` · reviewed by @${f.reviewer}` : ''}</span>
                      {f.detail && <span className="text-slate-500 truncate max-w-[20rem]" title={f.detail}>{f.detail}</span>}
                      <span className="ml-auto flex items-center gap-1.5">
                        {f.assigned ? (
                          <span className="text-emerald-300">task #{f.assigned.num ?? '?'} → @{f.assigned.agent_name ?? '?'} · {f.assigned.status}</span>
                        ) : (
                          <>
                            <select
                              value={assignPick[f.run_id] ?? f.author_agent_id ?? ''}
                              onChange={(e) => setAssignPick((p) => ({ ...p, [f.run_id]: e.target.value }))}
                              className={field}
                              aria-label={`Assign fix ${f.sha.slice(0, 8)}`}
                            >
                              <option value="">agent…</option>
                              {board.agents.map((a) => (
                                <option key={a.id} value={a.id}>
                                  @{a.alias ?? a.name} · {a.status}{a.budget.weekly_left !== null ? ` · ${a.budget.weekly_left}% wk` : ''}
                                </option>
                              ))}
                            </select>
                            <button
                              onClick={() => assignFix(f)}
                              disabled={acting !== null || !(assignPick[f.run_id] ?? f.author_agent_id)}
                              className="px-2 py-1 rounded border border-orange-500/40 text-[9px] font-semibold tracking-wider text-orange-200 hover:bg-orange-500/10 disabled:opacity-40"
                            >
                              {acting === `fix-${f.run_id}` ? '...' : 'ASSIGN'}
                            </button>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 4. Attention */}
            {board.attention.length > 0 && (
              <section className="rounded-lg border border-amber-500/25 bg-amber-950/10 p-3" data-testid="attention">
                <p className="text-[10px] font-semibold tracking-wider text-amber-300 mb-1.5">NEEDS A DECISION</p>
                <ul className="space-y-1 text-[11px] text-slate-300">
                  {board.attention.map((a, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="text-[9px] text-amber-400/80 uppercase tracking-wider w-28 shrink-0">{a.kind.replace(/_/g, ' ')}</span>
                      <span className="flex-1">{a.text}</span>
                      {a.run_id && a.kind === 'promotable' && (
                        <button onClick={() => navigate('/release')} className="text-[9px] text-emerald-300 underline underline-offset-2">release</button>
                      )}
                      {a.agent_id && a.kind !== 'fix_unassigned' && (
                        <button onClick={() => navigate(`/agent/${a.agent_id}`)} className="text-[9px] text-sky-300 underline underline-offset-2">open</button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 5. Agents */}
            <section>
              <p className="text-[9px] uppercase tracking-[0.3em] text-slate-500 mb-2">Agents</p>
              <div className="overflow-x-auto rounded-lg border border-slate-800/60">
                <table className="w-full text-[11px]" data-testid="agents">
                  <thead className="bg-slate-900/60 text-[9px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2">Agent</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Doing</th>
                      <th className="text-left px-3 py-2">Last reply</th>
                      <th className="text-left px-3 py-2">Blocked on</th>
                      <th className="text-left px-3 py-2">Budget</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {board.agents.map((a) => {
                      const note = noteFor(a.id);
                      return (
                        <tr key={a.id} className="align-top" data-testid={`agent-${a.name}`}>
                          <td className="px-3 py-2">
                            <button onClick={() => navigate(`/agent/${a.id}`)} className="text-cyan-300 hover:text-cyan-200">@{a.alias ?? a.name}</button>
                            <div className="text-[9px] text-slate-600">{a.runtime}{a.model ? ` · ${a.model}` : ''}</div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${STATUS_CLS[a.status] ?? ''}`}>{a.status.toUpperCase()}</span>
                            <div className="text-[9px] text-slate-600">{ago(a.for_min)}</div>
                          </td>
                          <td className="px-3 py-2 max-w-[22rem]">
                            {a.current ? (
                              <div className="text-slate-300 line-clamp-2" title={a.current.prompt}>{a.current.num ? `#${a.current.num} ` : ''}{a.current.prompt}</div>
                            ) : <span className="text-slate-600">—</span>}
                            {note && <div className="text-[10px] text-violet-300/90 mt-0.5">{note}</div>}
                          </td>
                          <td className="px-3 py-2 max-w-[22rem]">
                            {a.last_reply ? <div className="text-slate-400 line-clamp-2" title={a.last_reply.text}>{a.last_reply.text}</div> : <span className="text-slate-600">—</span>}
                          </td>
                          <td className="px-3 py-2">{a.blocked_on ? <span className="text-amber-300">{a.blocked_on}</span> : <span className="text-slate-600">—</span>}</td>
                          <td className="px-3 py-2">
                            {a.budget.weekly_left !== null ? (
                              <>
                                <span className={budgetCls(a.budget.weekly_left)}>{a.budget.weekly_left}% week</span>
                                {a.budget.five_h_left !== null && <span className={`ml-2 ${budgetCls(a.budget.five_h_left)}`}>{a.budget.five_h_left}% 5h</span>}
                                {a.budget.resets && <div className="text-[9px] text-slate-600">resets {a.budget.resets}</div>}
                              </>
                            ) : <span className="text-slate-600">{a.usage ?? '—'}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 6. Lanes */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[9px] uppercase tracking-[0.3em] text-slate-500">Lanes</p>
                <button onClick={() => navigate('/release')} className="text-[10px] text-sky-300 underline underline-offset-2">Release view</button>
              </div>
              {board.lanes.length === 0 ? (
                <p className="text-[11px] text-slate-600">No reviewed lanes.</p>
              ) : (
                <ul className="divide-y divide-slate-800/50 rounded-lg border border-slate-800/60 text-[11px]" data-testid="lanes">
                  {board.lanes.map((l) => (
                    <li key={l.sha} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${l.status === 'stale' ? 'opacity-60' : ''}`}>
                      <span className="text-slate-200">{l.project ?? '—'}{l.desk ? ` · Desk #${l.desk}` : ''}</span>
                      <span className="font-mono text-slate-400" title={l.sha}>{l.sha.slice(0, 8)}</span>
                      <span className="font-mono text-[10px] text-slate-600">{l.lane ?? ''}</span>
                      <span className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${l.verdict === 'pass' ? 'text-emerald-300 border-emerald-500/40' : 'text-amber-300 border-amber-500/40'}`}>{(l.verdict ?? 'none').toUpperCase().replace('-', ' ')}</span>
                      {l.gate && <span className={`text-[9px] font-bold ${l.gate === 'GREEN' ? 'text-emerald-300' : 'text-red-300'}`}>{l.gate}</span>}
                      {l.candidate && <span className="text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border text-violet-300 border-violet-500/40">IN {l.candidate.toUpperCase()}</span>}
                      <span className="text-[10px] text-slate-500">staging: {l.staging?.status ?? '—'} · prod: {l.production?.status ?? '—'}</span>
                      <span className="text-[10px] text-slate-400 ml-auto">{l.next}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
