import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';

/** Mirrors src/server/deliveries.ts (STAGES, summarize()). */
export const STAGES = ['spec', 'build', 'first_pass', 'gates', 'review', 'land', 'candidate', 'release'] as const;
export type Stage = (typeof STAGES)[number];

export interface DeliveryStage {
  stage: Stage;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  outcome: 'ok' | 'fail' | 'skipped' | 'superseded' | null;
  cause: string | null;
  actor: string | null;
  sha: string | null;
  lane: string | null;
}

export interface DeliverySummary {
  id: string;
  title: string;
  project: string | null;
  lanes: string[];
  shas: string[];
  release_lane: boolean;
  stage: Stage | null;
  stage_started_at: string | null;
  stage_minutes: number | null;
  last_progress_at: string | null;
  attempts: number;
  status: 'open' | 'done' | 'failed' | 'cancelled';
  stall_cause: string | null;
  stall_at: string | null;
  created_by: string | null;
  since_at: string;
  open_stages: Stage[];
  stalls: { stage: Stage; code: 'BLOCKED' | 'OVERRUN'; cause: string; minutes: number; actor: string | null }[];
  stages?: DeliveryStage[];
}

const STAGE_LABEL: Record<Stage, string> = {
  spec: 'spec', build: 'build', first_pass: 'first pass', gates: 'gates', review: 'review', land: 'land', candidate: 'candidate', release: 'release',
};

export function fmtMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

function minutesBetween(from: string, to: string | null, now: number): number {
  return Math.max(0, Math.floor(((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 60_000));
}

/** One pill per stage: the latest span of that stage decides the tone. */
export function stageTone(d: DeliverySummary, stage: Stage): 'done' | 'open' | 'stalled' | 'failed' | 'todo' {
  if (d.stalls.some((s) => s.stage === stage)) return 'stalled';
  if (d.open_stages.includes(stage)) return 'open';
  const spans = (d.stages ?? []).filter((s) => s.stage === stage);
  const last = spans[spans.length - 1];
  if (last?.outcome === 'ok') return 'done';
  if (last?.outcome === 'fail') return 'failed';
  if (!last) {
    // Without spans (list view) fall back to the stage order: everything before the current stage is done.
    const cur = d.stage ? STAGES.indexOf(d.stage) : -1;
    if (d.status === 'done') return 'done';
    return STAGES.indexOf(stage) < cur ? 'done' : 'todo';
  }
  return 'todo';
}

const TONE: Record<ReturnType<typeof stageTone>, string> = {
  done: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40',
  open: 'text-cyan-200 border-cyan-500/40 bg-cyan-950/40',
  stalled: 'text-amber-200 border-amber-500/50 bg-amber-950/40',
  failed: 'text-rose-200 border-rose-500/40 bg-rose-950/40',
  todo: 'text-slate-500 border-slate-800 bg-slate-900/40',
};

/**
 * Deliveries: a feature from spec to production as one record
 * (docs/ops/delivery-tracker-plan.md). Time in stage and the stall cause are
 * what the driver seat and the people on the phone look at.
 */
export default function Deliveries() {
  const [rows, setRows] = useState<DeliverySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeliverySummary | null>(null);
  const [form, setForm] = useState({ title: '', project: '', lanes: '' });
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<DeliverySummary[]>(`/deliveries?status=${showAll ? 'all' : 'open'}`)
      .then((next) => { setRows(next ?? []); setError(null); })
      .catch(() => setError('daemon unreachable'));
  }, [showAll]);

  const loadDetail = useCallback((id: string) => {
    apiGet<DeliverySummary>(`/deliveries/${id}`).then(setDetail).catch(() => setDetail(null));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => { if (openId) loadDetail(openId); else setDetail(null); }, [openId, loadDetail]);

  const handleSSE = useCallback((event: SSEEvent) => {
    if (event.type.startsWith('delivery.') || event.type.startsWith('release.') || event.type.startsWith('merge_queue.')) {
      load();
      if (openId) loadDetail(openId);
    }
  }, [load, loadDetail, openId]);
  useSSE(handleSSE);

  const create = async () => {
    if (!form.title.trim()) { setFormError('title is required'); return; }
    setCreating(true); setFormError(null);
    try {
      const lanes = form.lanes.split(/[\s,]+/).map((l) => l.trim()).filter(Boolean);
      const created = await apiPost<DeliverySummary>('/deliveries', { title: form.title.trim(), project: form.project.trim() || null, lanes });
      setForm({ title: '', project: '', lanes: '' });
      setOpenId(created.id);
      load();
    } catch (e) {
      setFormError((e as Error).message || 'could not create the delivery');
    } finally {
      setCreating(false);
    }
  };

  const now = Date.now();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="sticky top-0 z-10 border-b border-slate-800/50 bg-slate-950/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Deliveries</h1>
          <label className="ml-auto flex items-center gap-1 text-[10px] text-slate-500 cursor-pointer">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="deliveries-show-all" />
            show closed
          </label>
          {error && <span className="text-[10px] text-amber-300">{error}</span>}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-4 text-[11px]">
        <section className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3" data-testid="delivery-create">
          <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-2">New delivery</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              className="flex-1 rounded bg-slate-950 border border-slate-800 px-2 py-1 text-slate-100 placeholder:text-slate-600"
              placeholder="Title (what ships)"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              data-testid="delivery-title"
            />
            <input
              className="sm:w-32 rounded bg-slate-950 border border-slate-800 px-2 py-1 text-slate-100 placeholder:text-slate-600"
              placeholder="project"
              value={form.project}
              onChange={(e) => setForm({ ...form, project: e.target.value })}
            />
            <input
              className="flex-1 rounded bg-slate-950 border border-slate-800 px-2 py-1 text-slate-100 placeholder:text-slate-600 font-mono"
              placeholder="lanes (branch names, comma separated)"
              value={form.lanes}
              onChange={(e) => setForm({ ...form, lanes: e.target.value })}
              data-testid="delivery-lanes"
            />
            <button
              onClick={create}
              disabled={creating}
              className="rounded border border-emerald-500/40 bg-emerald-950/40 px-3 py-1 text-emerald-200 disabled:opacity-50"
              data-testid="delivery-submit"
            >
              Track
            </button>
          </div>
          {formError && <p className="mt-1 text-amber-300" data-testid="delivery-form-error">{formError}</p>}
          <p className="mt-1 text-[10px] text-slate-600">
            Stages are derived from pipeline events (freeze, first pass, gates, review, queue, release); add a lane and WaveCode fills in the rest.
          </p>
        </section>

        {!rows && !error ? (
          <p className="text-[10px] text-slate-600 animate-pulse">Loading…</p>
        ) : rows && rows.length === 0 ? (
          <p className="text-[10px] text-slate-600" data-testid="deliveries-empty">No {showAll ? '' : 'open '}deliveries.</p>
        ) : rows ? (
          <section className="space-y-2" data-testid="deliveries-list">
            {rows.map((d) => {
              const expanded = openId === d.id;
              const shown = expanded && detail?.id === d.id ? detail : d;
              return (
                <article
                  key={d.id}
                  data-testid={`delivery-${d.id}`}
                  className={`rounded-lg border px-4 py-3 ${d.stalls.length ? 'border-amber-500/40 bg-amber-950/10' : 'border-slate-800 bg-slate-900/40'}`}
                >
                  <div className="flex flex-wrap items-center gap-2 cursor-pointer" onClick={() => setOpenId(expanded ? null : d.id)}>
                    <span className="font-semibold text-slate-100">{d.title}</span>
                    {d.project && <span className="text-[10px] text-slate-500">{d.project}</span>}
                    {d.release_lane && <span className="text-[9px] uppercase tracking-wider text-violet-300 border border-violet-500/40 rounded px-1">release lane</span>}
                    <span className={`ml-auto text-[9px] uppercase tracking-wider ${d.status === 'open' ? 'text-slate-400' : d.status === 'done' ? 'text-emerald-300' : 'text-rose-300'}`} data-testid={`delivery-status-${d.id}`}>
                      {d.status}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1" data-testid={`delivery-stages-${d.id}`}>
                    {STAGES.map((stage) => {
                      const tone = stageTone(shown, stage);
                      const current = d.stage === stage && d.status === 'open';
                      return (
                        <span key={stage} className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${TONE[tone]}`} data-tone={tone}>
                          {STAGE_LABEL[stage]}{current && d.stage_minutes !== null ? ` · ${fmtMinutes(d.stage_minutes)}` : ''}
                        </span>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-slate-400">
                    {d.status === 'open' && d.stage ? <>in <span className="text-slate-200">{STAGE_LABEL[d.stage]}</span> for {fmtMinutes(d.stage_minutes)}</> : d.status}
                    {' · '}attempt {d.attempts}
                    {d.lanes.length > 0 && <> · <span className="font-mono text-slate-500">{d.lanes.join(', ')}</span></>}
                    {d.shas.length > 0 && <> · {d.shas.length} SHA{d.shas.length === 1 ? '' : 's'}</>}
                  </p>
                  {d.stalls.map((s) => (
                    <p key={`${s.stage}-${s.code}`} className="mt-1 text-amber-300" data-testid={`delivery-stall-${d.id}`}>
                      {s.code} in {STAGE_LABEL[s.stage]} ({fmtMinutes(s.minutes)}){s.actor ? ` · @${s.actor}` : ''}: {s.cause}
                    </p>
                  ))}
                  {expanded && (
                    <div className="mt-3 overflow-x-auto" data-testid={`delivery-detail-${d.id}`}>
                      {!detail ? (
                        <p className="text-[10px] text-slate-600 animate-pulse">Loading stages…</p>
                      ) : (
                        <table className="w-full text-left">
                          <thead className="text-[9px] uppercase tracking-wider text-slate-500">
                            <tr>
                              <th className="pr-3 py-1 font-semibold">Stage</th>
                              <th className="pr-3 py-1 font-semibold">#</th>
                              <th className="pr-3 py-1 font-semibold">Started</th>
                              <th className="pr-3 py-1 font-semibold">Took</th>
                              <th className="pr-3 py-1 font-semibold">Outcome</th>
                              <th className="pr-3 py-1 font-semibold">SHA</th>
                              <th className="pr-3 py-1 font-semibold">Who</th>
                              <th className="py-1 font-semibold">Note</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(detail.stages ?? []).map((s, i) => (
                              <tr key={i} className="border-t border-slate-800/80 text-slate-400">
                                <td className="pr-3 py-1 text-slate-200">{STAGE_LABEL[s.stage]}</td>
                                <td className="pr-3 py-1">{s.attempt}</td>
                                <td className="pr-3 py-1 whitespace-nowrap">{s.started_at.slice(11, 16)}</td>
                                <td className="pr-3 py-1 whitespace-nowrap">{fmtMinutes(minutesBetween(s.started_at, s.finished_at, now))}{s.finished_at ? '' : ' (open)'}</td>
                                <td className={`pr-3 py-1 ${s.outcome === 'ok' ? 'text-emerald-300' : s.outcome === 'fail' ? 'text-rose-300' : ''}`}>{s.outcome ?? 'open'}</td>
                                <td className="pr-3 py-1 font-mono">{s.sha ? s.sha.slice(0, 8) : ''}</td>
                                <td className="pr-3 py-1">{s.actor ? `@${s.actor}` : ''}</td>
                                <td className="py-1">{s.cause ?? ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        ) : null}
      </main>
    </div>
  );
}
