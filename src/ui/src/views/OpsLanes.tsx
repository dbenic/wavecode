import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { OpsJobView, OpsLanesReport } from '../types';

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
  const [jobs, setJobs] = useState<OpsJobView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [company, setCompany] = useState('');
  const [env, setEnv] = useState<'staging' | 'prod'>('staging');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [askNote, setAskNote] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<OpsLanesReport>('/ops-lanes')
      .then((next) => { setReport(next ?? null); setError(null); })
      .catch(() => setError('daemon unreachable'));
    apiGet<OpsJobView[]>('/ops/jobs')
      .then((next) => setJobs(Array.isArray(next) ? next : []))
      .catch(() => setJobs([]));
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
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Bot</th>
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
                    <td className="px-3 py-2">{cell(lane.bot)}</td>
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

        <section className="mt-6 rounded-lg border border-slate-800" data-testid="ops-jobs">
          <h2 className="px-3 py-2 text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Jobs</h2>
          <p className="px-3 pb-2 text-[10px] text-slate-500">Recorded here. A bot pulls its own role. WaveCode does not run the scripts.</p>
          {jobs.length === 0 ? (
            <p className="px-3 pb-3 text-slate-500" data-testid="ops-jobs-empty">No jobs yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead className="text-[9px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Requester</th>
                  <th className="px-3 py-2 font-semibold">Receipts</th>
                  <th className="px-3 py-2 font-semibold">Approval</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} data-testid={`ops-job-${job.id}`} className="border-t border-slate-800/80 text-slate-300">
                    <td className="px-3 py-2">{job.status}</td>
                    <td className="px-3 py-2">{job.role}</td>
                    <td className="px-3 py-2">{job.requester}</td>
                    <td className="px-3 py-2 font-mono">{job.receipt_paths.length > 0 ? job.receipt_paths.join(', ') : '—'}</td>
                    <td className="px-3 py-2">{job.approval ? `${job.approval.by} · ${job.approval.at}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <form
          className="mt-6 max-w-xl space-y-2 rounded-lg border border-slate-800 p-3"
          data-testid="ops-ask"
          onSubmit={(event) => {
            event.preventDefault();
            if (asking) return;
            setAsking(true);
            setAskNote(null);
            apiPost<OpsJobView>('/ops/ask', { company, env, question })
              .then((job) => {
                const recorded = (job as unknown as { job?: OpsJobView }).job ?? job;
                setAskNote(recorded.status === 'awaiting_owner'
                  ? 'Waiting for Denis or Antonio. Approval only records consent.'
                  : 'Queued for the scout. Read only.');
                setQuestion('');
                load();
              })
              .catch((err: Error) => setAskNote(err.message || 'That did not go through'))
              .finally(() => setAsking(false));
          }}
        >
          <h2 className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Ask for data</h2>
          <label className="block text-[10px] text-slate-500">
            Company
            <input
              data-testid="ask-company"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100"
            />
          </label>
          <label className="block text-[10px] text-slate-500">
            Env
            <select
              data-testid="ask-env"
              value={env}
              onChange={(event) => setEnv(event.target.value === 'prod' ? 'prod' : 'staging')}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100"
            >
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </select>
          </label>
          <label className="block text-[10px] text-slate-500">
            Question
            <textarea
              data-testid="ask-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100"
            />
          </label>
          <button
            type="submit"
            data-testid="ask-submit"
            disabled={asking || !company.trim() || !question.trim()}
            className="rounded border border-sky-500/40 px-3 py-1 text-[11px] font-semibold text-sky-200 disabled:opacity-40"
          >
            {asking ? 'Sending…' : 'Ask'}
          </button>
          {askNote && <p className="text-[11px] text-slate-300" data-testid="ask-note">{askNote}</p>}
        </form>
      </main>
    </div>
  );
}
