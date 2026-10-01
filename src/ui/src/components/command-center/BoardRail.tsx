/**
 * The collapsed Board (spec §4.4): a 40px rail with badges — open tasks,
 * pending reviews, attention — that expands the Board on click.
 */

interface BoardRailProps {
  openTasks: number;
  pendingReviews: number;
  attention: number;
  onExpand: () => void;
}

function Badge({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span title={`${label}: ${value}`} aria-label={`${label}: ${value}`} className="flex flex-col items-center gap-0.5">
      <span className={`min-w-[1.5rem] rounded-full px-1 text-center text-[11px] font-semibold tabular-nums ${value > 0 ? tone : 'bg-slate-800 text-slate-500'}`}>
        {value}
      </span>
      <span aria-hidden className="text-[8px] uppercase tracking-wider text-slate-600">{label.split(' ')[0].slice(0, 4)}</span>
    </span>
  );
}

export default function BoardRail({ openTasks, pendingReviews, attention, onExpand }: BoardRailProps) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand board"
      title="Expand board"
      className="flex h-full w-10 flex-col items-center gap-3 py-3 hover:bg-slate-900/60"
    >
      <span aria-hidden className="text-xs text-slate-500">◂</span>
      <Badge label="Open tasks" value={openTasks} tone="bg-sky-500/20 text-sky-300" />
      <Badge label="Pending reviews" value={pendingReviews} tone="bg-violet-500/20 text-violet-300" />
      <Badge label="Attention" value={attention} tone="bg-amber-500 text-slate-950" />
    </button>
  );
}
