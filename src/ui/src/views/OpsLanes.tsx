import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../hooks/useApi';
import type { OpsLanesReport } from '../types';

export function fmtAge(ageS: number): string {
  if (ageS < 60) return `${ageS} s`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)} min`;
  return `${Math.floor(ageS / 3600)} h ${String(Math.floor(ageS / 60) % 60).padStart(2, '0')} min`;
}

function cell(value: string): string {
  return value || 'unknown';
}

/**
 * Ops lanes Live board. The daemon reads heartbeat files; this page only
 * fetches the snapshot.
 */
export default function OpsLanes() {
  const [report, setReport] = useState<OpsLanesReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<OpsLanesReport>('/ops-lanes')
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
          <h1 className="text-sm font-bold tracking-[0.15em] text-slate-100 uppercase">Ops lanes</h1>
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Live</span>
          <span className="ml-auto text-[10px] text-slate-500" data-testid="ops-collected">
            {error ? <span className="text-amber-300">{error}</span> : report?.collected_at ? `read ${report.collected_at}` : 'not collected yet'}
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5 text-[11px]">
        {!report && !error ? (
          <p className="text-[10px] text-slate-600 animate-pulse">Loading…</p>
        ) : report ? (
          <section data-testid="ops-live" className="overflow-x-auto rounded-lg border border-slate-800">
            {report.dir_error && (
              <p className="px-3 py-2 text-red-300" data-testid="ops-dir-error">directory {report.dir_error}</p>
            )}
            <table className="w-full text-left">
              <thead className="text-[9px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Bot</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Model</th>
                  <th className="px-3 py-2 font-semibold">Key</th>
                  <th className="px-3 py-2 font-semibold">Checked</th>
                  <th className="px-3 py-2 font-semibold">Job</th>
                  <th className="px-3 py-2 font-semibold">Heartbeat</th>
                  <th className="px-3 py-2 font-semibold">Receipt</th>
                  <th className="px-3 py-2 font-semibold">Receipt at</th>
                </tr>
              </thead>
              <tbody>
                {report.lanes.map((lane) => (
                  <tr
                    key={lane.id}
                    data-testid={`ops-lane-${lane.id}`}
                    data-red={lane.red ? 'true' : 'false'}
                    className={`border-t border-slate-800/80 ${lane.red ? 'bg-red-950/40 text-red-200' : 'text-slate-300'}`}
                  >
                    <td className="px-3 py-2 text-slate-100">{lane.id}</td>
                    <td className="px-3 py-2">{cell(lane.role)}</td>
                    <td className="px-3 py-2">{cell(lane.model)}</td>
                    <td className="px-3 py-2">{lane.key_status}</td>
                    <td className="px-3 py-2">{cell(lane.key_checked_at)}</td>
                    <td className="px-3 py-2">{cell(lane.current_job)}</td>
                    <td className="px-3 py-2">{lane.heartbeat_at === 'unknown' ? 'unknown' : `${lane.heartbeat_at} · ${lane.heartbeat_age_s == null ? 'unknown' : fmtAge(lane.heartbeat_age_s)}`}</td>
                    <td className="px-3 py-2">{cell(lane.last_receipt_path)}</td>
                    <td className="px-3 py-2">{cell(lane.last_receipt_at)}{lane.reasons.length > 0 ? ` · ${lane.reasons.join(' ')}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </main>
    </div>
  );
}
