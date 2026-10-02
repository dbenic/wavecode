/**
 * Room proposals in the review queue (spec §5f): template / ROOM.md / SPEC.md
 * changes a seat (usually the nightly retro) proposed, with the evidence and
 * the diff. Promote applies the change; reject drops it. Who may decide is
 * the server's call — a refusal shows its reason.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../hooks/useApi';
import type { RoomProposal } from '../types';

/** `version` changes when the parent sees a room.proposal_* event (it owns the SSE subscription). */
export default function RoomProposals({ version = 0 }: { version?: number }) {
  const [proposals, setProposals] = useState<RoomProposal[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<RoomProposal[]>('/proposals?status=pending').then(setProposals).catch(() => setProposals([]));
  }, []);

  useEffect(() => { load(); }, [load, version]);

  async function decide(p: RoomProposal, action: 'promote' | 'reject') {
    setError(null);
    try {
      await apiPost(`/proposals/${p.id}/${action}`);
    } catch (e) {
      setError((e as Error).message);
    }
    load();
  }

  if (proposals.length === 0) return null;

  return (
    <section aria-label="Room proposals" className="mb-6 space-y-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Room proposals</h2>
      {proposals.map((p) => (
        <article key={p.id} data-testid={`proposal-${p.id}`} className="rounded-lg border border-violet-500/30 bg-slate-900/60 p-3">
          <div className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="font-semibold text-slate-200">{p.room}</span>
            <span className="font-mono text-violet-300">{p.path}</span>
            <span className="text-slate-600">{p.created_at}</span>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-300"><span className="text-slate-500">Evidence: </span>{p.evidence}</p>
          <pre aria-label="Diff" className="mt-2 max-h-64 overflow-auto rounded bg-slate-950 p-2 text-[11px] leading-snug">
            {p.diff.split('\n').map((line, i) => (
              <div key={i} className={line.startsWith('+ ') ? 'text-emerald-400' : line.startsWith('- ') ? 'text-red-400' : 'text-slate-500'}>{line}</div>
            ))}
          </pre>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void decide(p, 'promote')} className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">Promote</button>
            <button type="button" onClick={() => void decide(p, 'reject')} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-300">Reject</button>
          </div>
        </article>
      ))}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
