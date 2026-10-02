import type { Task, TemplateMetrics, User } from '../../types';
import { swimlanes } from '../../utils/command-center';
import { TASK_DRAG_TYPE } from './Roster';

interface BoardProps {
  tasks: Task[];
  users: Map<string, User>;
  reviewCount: number;
  canAssign: boolean;
  /** Collapse to the badge rail (spec §4.4); desktop only. */
  onCollapse?: () => void;
  /** Per-template metrics of the viewer's room (spec §5f). */
  metrics?: { room: string; templates: TemplateMetrics[] } | null;
}

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

/** The metrics strip: one line per template that has tasks. */
export function MetricsStrip({ metrics }: { metrics: { room: string; templates: TemplateMetrics[] } }) {
  const used = metrics.templates.filter((m) => m.tasks > 0);
  if (used.length === 0) return null;
  return (
    <div aria-label="Template metrics" className="rounded-lg bg-slate-900/40 p-2 text-[11px] text-slate-400">
      <div className="mb-1 text-[10px] uppercase tracking-[0.2em] text-slate-600">{metrics.room} · templates</div>
      {used.map((m) => (
        <div key={m.template} data-testid={`metrics-${m.template}`} className="flex flex-wrap gap-x-2">
          <span className="font-semibold text-slate-300">{m.template}</span>
          <span title="verdict PASS on fix round 0">{pct(m.first_pass_rate)} first pass</span>
          <span>{m.mean_fix_rounds ?? '—'} fixes</span>
          <span>{m.questions_rate ?? '—'} q/task</span>
          <span>{m.mean_time_to_result_s === null ? '—' : `${Math.round(m.mean_time_to_result_s / 60)}m`} to RESULT</span>
        </div>
      ))}
    </div>
  );
}

const STATUS_CLASS: Record<Task['status'], string> = {
  running: 'text-emerald-400',
  pending: 'text-slate-400',
  blocked: 'text-amber-400',
  failed: 'text-red-400',
  done: 'text-slate-600',
};

const STATUS_GLYPH: Record<Task['status'], string> = {
  running: '▶', pending: '○', blocked: '⏸', failed: '✗', done: '✓',
};

export default function Board({ tasks, users, reviewCount, canAssign, onCollapse, metrics }: BoardProps) {
  const lanes = swimlanes(tasks.filter((t) => t.status !== 'done' || isRecent(t)), users);
  return (
    <section aria-label="Board" className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600">Board</h2>
        <span className="flex items-center gap-2">
          <span className="text-xs text-slate-400">reviews: {reviewCount}</span>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse board"
              title="Collapse board"
              className="hidden text-xs text-slate-500 hover:text-slate-300 sm:inline"
            >
              ▸
            </button>
          )}
        </span>
      </div>
      {metrics && <MetricsStrip metrics={metrics} />}
      {lanes.length === 0 && <p className="text-xs text-slate-600">No tasks yet.</p>}
      {lanes.map((lane) => (
        <div key={lane.ownerId ?? 'system'} aria-label={`Lane ${lane.label}`} className="rounded-lg border-l-2 bg-slate-900/40 p-2" style={{ borderLeftColor: lane.color }}>
          <h3 className="mb-1 text-xs font-semibold text-slate-300">{lane.label}</h3>
          <ul className="flex flex-col gap-1">
            {lane.tasks.map((task) => {
              const draggable = canAssign && (task.status === 'pending' || task.status === 'blocked' || task.status === 'failed');
              return (
                <li
                  key={task.id}
                  draggable={draggable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  title={draggable ? 'Drag onto an agent to assign' : undefined}
                  className={`flex items-start gap-1.5 rounded px-1.5 py-1 text-xs ${draggable ? 'cursor-grab hover:bg-slate-800/60' : ''}`}
                >
                  <span className={STATUS_CLASS[task.status]} aria-label={task.status}>{STATUS_GLYPH[task.status]}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-300">{task.prompt}</span>
                  {task.dependencies && task.dependencies.length > 0 && (
                    <span className="shrink-0 text-slate-600" title="Depends on">↳{task.dependencies.length}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** Keep finished tasks from the last day so lanes show recent progress, not history. */
function isRecent(task: Task): boolean {
  return Date.now() - Date.parse(task.created_at) < 24 * 3_600_000;
}
