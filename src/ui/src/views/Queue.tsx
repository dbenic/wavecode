import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../hooks/useApi';
import type { FableQueueReport, FableStageCell, FableStageName } from '../types';

const STAGES: FableStageName[] = ['freeze', 'review', 'staged', 'GO-ready', 'live'];

const STATE_TONE: Record<string, string> = {
  working: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/40',
  idle: 'text-slate-300 border-slate-600/50 bg-slate-900',
  waiting_input: 'text-amber-200 border-amber-500/40 bg-amber-950/40',
  queued: 'text-cyan-200 border-cyan-500/40 bg-cyan-950/40',
  unknown: 'text-slate-400 border-slate-700 bg-slate-900/60',
};

export function fmtAge(ageS: number): string {
  if (ageS < 60) return `${ageS} s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)} min`;
  return `${Math.floor(ageS / 3600)} h ${String(Math.floor(ageS / 60) % 60).padStart(2, '0')} min`;
}

function stageText(cell: FableStageCell): string {
  if (cell.status === 'unknown') return 'unknown';
  return `${cell.name} · ${fmtAge(cell.age_s)}`;
}

/**
 * Fable Queue: pane state, pending briefs, and pipeline cards.
 * The daemon collects this read-only; the page only fetches the snapshot.
 */
export default function Queue() {
  const [report, setReport] = useState<FableQueueReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<FableQueueReport>('/queue')
      .then((next) => { setReport(next ?? null); setError(null); })
      .catch(() => setError('daemon unreachable'));
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <header className="sticky top-0 z-10 border-b border-slate-800/50 bg-slate-950/90 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Queue</h1>
          <span className="ml-auto text-[10px] text-slate-500" data-testid="queue-collected">
            {error ? <span className="text-amber-300">{error}</span> : report?.collected_at ? `read ${report.collected_at}` : 'not collected yet'}
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 space-y-5 text-[11px]">
        {!report && !error ? (
          <p className="text-[10px] text-slate-600 animate-pulse">Loading…</p>
        ) : report ? (
          <>
            {report.alerts.length > 0 && (
              <section className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3" data-testid="queue-alerts">
                <div className="text-[9px] uppercase tracking-wider text-amber-300 mb-1">Alerts</div>
                <ul className="space-y-1">
                  {report.alerts.map((alert, i) => (
                    <li key={`${alert.kind}-${alert.bot}-${i}`}>
                      {alert.kind === 'pending_too_long'
                        ? `${alert.bot}: ${alert.name} pending ${fmtAge(alert.age_s)} (over ${report.pending_alert_min} min)`
                        : `${alert.bot}: idle with ${alert.pending} pending`}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section data-testid="queue-bots" className="space-y-2">
              {report.bots.map((bot) => (
                <article key={bot.id} data-testid={`queue-bot-${bot.id}`} className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-100">{bot.id}</span>
                    <span className="text-[10px] text-slate-500 font-mono">{bot.socket}/{bot.session}</span>
                    <span className={`ml-auto px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wider ${STATE_TONE[bot.state] ?? STATE_TONE.unknown}`}>
                      {bot.state}
                    </span>
                  </div>
                  {bot.state_error && <p className="mt-1 text-amber-300" data-testid={`queue-state-error-${bot.id}`}>{bot.state_error}</p>}
                  {(bot.inbox_error || bot.outbox_error) && (
                    <p className="mt-1 text-slate-500">
                      {bot.inbox_error ? `inbox ${bot.inbox_error}` : ''}{bot.inbox_error && bot.outbox_error ? ' · ' : ''}{bot.outbox_error ? `outbox ${bot.outbox_error}` : ''}
                    </p>
                  )}
                  <ul className="mt-1 space-y-1 text-slate-400" data-testid={`queue-briefs-${bot.id}`}>
                    {bot.briefs.map((brief) => (
                      <li key={brief.name}>
                        <span>{brief.status} {brief.name}</span>
                        {brief.expected?.map((item) => (
                          <span key={item.name} className="block pl-3">{item.status} {item.name}</span>
                        ))}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-slate-400" data-testid={`queue-unpaired-${bot.id}`}>
                    unpaired {bot.unpaired.length ? bot.unpaired.map((brief) => brief.name).join(', ') : 'none'}
                    {' · '}
                    newest receipt {bot.newest_receipt ? `${bot.newest_receipt.name} · ${fmtAge(bot.newest_receipt.age_s)}` : 'none'}
                  </p>
                  {bot.capture && (
                    <pre data-testid={`queue-capture-${bot.id}`} className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate-500">{bot.capture}</pre>
                  )}
                </article>
              ))}
            </section>

            <section data-testid="queue-pipeline" className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-left">
                <thead className="text-[9px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Card</th>
                    {STAGES.map((stage) => <th key={stage} className="px-3 py-2 font-semibold">{stage}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {report.pipeline.map((row) => (
                    <tr key={row.card} data-testid={`queue-card-${row.card}`} className="border-t border-slate-800/80">
                      <td className="px-3 py-2 text-slate-100">{row.card}</td>
                      {STAGES.map((stage) => (
                        <td key={stage} className="px-3 py-2 text-slate-400">{stageText(row.stages[stage])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.notes_unavailable > 0 && (
                <p className="px-3 py-2 text-slate-500" data-testid="queue-notes-unavailable">
                  {report.notes_unavailable} note director{report.notes_unavailable === 1 ? 'y' : 'ies'} unavailable — those stages stay unknown
                </p>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
