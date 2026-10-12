import { useState } from 'react';
import { apiGet } from '../hooks/useApi';
import type { TestRunChip } from '../types';

function clockSpan(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  return `${Math.round(seconds / 60)}m`;
}

export function testChipLabel(run: TestRunChip): string {
  switch (run.state) {
    case 'queued': {
      const pos = run.queue_pos != null ? `#${run.queue_pos}` : '#?';
      const wait = run.wait_s != null ? `, waiting ${clockSpan(run.wait_s)}` : '';
      return `queued (${pos}${wait})`;
    }
    case 'running': {
      const bits = [run.host, run.suite, run.run_s != null ? clockSpan(run.run_s) : null].filter((x): x is string => !!x);
      return bits.length ? `running (${bits.join(', ')})` : 'running';
    }
    case 'pass': return 'PASS';
    case 'fail': return run.failing_step ? `FAIL: ${run.failing_step}` : 'FAIL';
    case 'hung': return 'HUNG';
    case 'superseded': return `SUPERSEDED${run.superseded_by ? ` (by ${run.superseded_by.slice(0, 8)})` : ''}`;
    case 'duplicate': return 'DUPLICATE';
    case 'cancelled': return 'CANCELLED';
    default: return run.state.toUpperCase();
  }
}

export default function TestChip({ run, project, canLog }: { run: TestRunChip; project?: string | null; canLog?: boolean }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && canLog && project && log == null && !logError) {
      apiGet<{ log: string | null }>(`/reviews/test-log?project=${encodeURIComponent(project)}&id=${encodeURIComponent(run.id)}`)
        .then((r) => setLog(r.log ?? ''))
        .catch((e) => setLogError((e as Error).message || 'log unavailable'));
    }
  };

  const hot = run.state === 'fail' || run.state === 'hung';
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={toggle}
        data-testid="test-chip"
        className={`text-[9px] font-bold tracking-wider rounded px-1.5 py-0.5 border ${hot ? 'text-red-300 border-red-500/40' : run.state === 'pass' ? 'text-emerald-300 border-emerald-500/40' : 'text-sky-300 border-sky-500/40'}`}
      >
        {testChipLabel(run)}
      </button>
      {open && (
        <span className="block max-w-md whitespace-pre-wrap text-[10px] font-normal tracking-normal text-slate-400" data-testid="test-summary">
          {run.summary || 'No summary.'}
          {canLog && log != null && <span className="mt-1 block font-mono text-slate-500">{log}</span>}
          {logError && <span className="mt-1 block text-red-300">{logError}</span>}
        </span>
      )}
    </span>
  );
}
