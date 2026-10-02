/**
 * Settings → My seat (spec §5d): your own orchestrator seat — create or
 * recreate it, edit the standing rules appended to its brief, re-brief it,
 * and revoke or rotate the seat token (its MCP access) without touching
 * your own login.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiDelete, apiGet, apiPost, apiPut } from '../hooks/useApi';

interface SeatInfo {
  status: 'none' | 'ok' | 'missing';
  agent?: { id: string; name: string; runtime: string; status: string; profile?: string | null };
  agent_id?: string;
  eligible: boolean;
  rules: string | null;
  has_token: boolean;
}

const RUNTIMES = ['claude-code', 'codex', 'grok'];
const MAX_RULES = 2000;

export default function MySeat() {
  const [seat, setSeat] = useState<SeatInfo | null>(null);
  const [rules, setRules] = useState('');
  const [runtime, setRuntime] = useState('claude-code');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const info = await apiGet<SeatInfo>('/users/me/seat');
      setSeat(info);
      setRules(info.rules ?? '');
    } catch {
      // ErrorBanner
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    await run(async () => {
      const res = await apiPost<{ mcp: { registered: boolean; error?: string } }>('/users/me/seat', { runtime });
      if (!res.mcp.registered) throw new Error(`Seat created, but MCP was not registered: ${res.mcp.error}`);
    }, 'Seat created — it is being briefed now.');
  }

  if (!seat) return <div className="p-4 text-xs text-slate-600">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center gap-3">
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-300">&larr;</Link>
        <h1 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">My seat</h1>
      </div>

      {!seat.eligible ? (
        <p className="text-sm text-slate-400">Observers have no orchestrator seat — the role is read-only.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <section aria-label="Seat" className="rounded-lg border border-slate-800 p-3 text-sm">
            {seat.status === 'ok' && seat.agent && (
              <p className="text-slate-200">
                <strong>{seat.agent.name}</strong> · {seat.agent.runtime} · {seat.agent.status}
                {seat.agent.profile ? ` · profile ${seat.agent.profile}` : ''}
              </p>
            )}
            {seat.status !== 'ok' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className={seat.status === 'missing' ? 'text-amber-400' : 'text-slate-400'}>
                  {seat.status === 'missing' ? 'Your seat is gone.' : 'You have no seat yet; Ask goes to the shared one.'}
                </span>
                <label className="sr-only" htmlFor="seat-runtime">Runtime</label>
                <select id="seat-runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)} className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200">
                  {RUNTIMES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button type="button" disabled={busy} onClick={() => void create()} className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40">
                  {seat.status === 'missing' ? 'Recreate my seat' : 'Create my seat'}
                </button>
              </div>
            )}
          </section>

          <section aria-label="Rules" className="flex flex-col gap-2">
            <label htmlFor="seat-rules" className="text-xs text-slate-400">
              Standing rules (appended to the seat&apos;s brief — e.g. &quot;always answer in Slovene&quot;, &quot;never promote without asking me&quot;)
            </label>
            <textarea
              id="seat-rules"
              rows={5}
              maxLength={MAX_RULES}
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              className="rounded border border-slate-700 bg-slate-900 p-2 text-sm text-slate-100"
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void run(() => apiPut('/users/me/seat/rules', { rules }), 'Rules saved.')} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 disabled:opacity-40">
                Save rules
              </button>
              <button
                type="button"
                disabled={busy || seat.status !== 'ok'}
                onClick={() => void run(async () => {
                  await apiPut('/users/me/seat/rules', { rules });
                  await apiPost('/users/me/seat/brief');
                }, 'Rules saved and the seat re-briefed — its next answers follow them.')}
                className="rounded border border-emerald-600 px-3 py-1 text-xs text-emerald-300 disabled:opacity-40"
              >
                Save &amp; re-brief
              </button>
            </div>
          </section>

          <section aria-label="Seat token" className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400">
              Seat token: {seat.has_token ? 'active (the seat can use WaveCode tools as you)' : 'revoked (the seat cannot call WaveCode)'}
            </span>
            {seat.has_token && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Revoke the seat token? The seat loses WaveCode access; your own login is unaffected.')) {
                    void run(() => apiDelete('/users/me/seat/token'), 'Seat token revoked.');
                  }
                }}
                className="rounded border border-red-500/60 px-2 py-0.5 text-red-300 disabled:opacity-40"
              >
                Revoke seat token
              </button>
            )}
            {seat.status === 'ok' && (
              <button type="button" disabled={busy} onClick={() => void run(() => apiPost('/users/me/seat/token'), 'New seat token issued and registered.')} className="rounded border border-slate-600 px-2 py-0.5 text-slate-300 disabled:opacity-40">
                {seat.has_token ? 'Rotate token' : 'Issue new token'}
              </button>
            )}
          </section>
        </div>
      )}

      {notice && <p role="status" className="mt-3 text-xs text-emerald-400">{notice}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
    </div>
  );
}
