import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '../types';
import { apiPost, apiPut, apiDelete } from '../hooks/useApi';

const STATUS_CONFIG: Record<
  string,
  { label: string; borderClass: string; dotClass: string; textClass: string; bgAccent: string }
> = {
  pending: {
    label: 'PENDING',
    borderClass: 'border-slate-700/50',
    dotClass: 'bg-slate-500',
    textClass: 'text-slate-500',
    bgAccent: '',
  },
  running: {
    label: 'RUNNING',
    borderClass: 'border-emerald-500/30 shadow-[0_0_15px_-5px_theme(colors.emerald.500/0.15)]',
    dotClass: 'bg-emerald-400 animate-pulse shadow-[0_0_4px_theme(colors.emerald.400)]',
    textClass: 'text-emerald-400',
    bgAccent: 'bg-gradient-to-b from-emerald-500/5 to-transparent',
  },
  done: {
    label: 'DONE',
    borderClass: 'border-cyan-500/20',
    dotClass: 'bg-cyan-400',
    textClass: 'text-cyan-400',
    bgAccent: '',
  },
  failed: {
    label: 'FAILED',
    borderClass: 'border-red-500/30 shadow-[0_0_15px_-5px_theme(colors.red.500/0.15)]',
    dotClass: 'bg-red-500',
    textClass: 'text-red-400',
    bgAccent: 'bg-gradient-to-b from-red-500/5 to-transparent',
  },
  blocked: {
    label: 'BLOCKED',
    borderClass: 'border-amber-500/30',
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-400',
    bgAccent: '',
  },
};

export default function TaskCard({
  task,
  agentName,
  index,
  onRefresh,
}: {
  task: Task;
  agentName?: string;
  index: number;
  onRefresh?: () => void;
}) {
  const navigate = useNavigate();
  const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending;
  const depCount = task.dependencies?.length ?? 0;
  const depOfCount = task.dependents?.length ?? 0;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPrompt, setEditPrompt] = useState(task.prompt);
  const [editPriority, setEditPriority] = useState(task.priority);
  const [saving, setSaving] = useState(false);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await apiPost(`/tasks/${task.id}/retry`);
      onRefresh?.();
    } catch {
      // retry failed silently
    }
  };

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await apiDelete(`/tasks/${task.id}`);
      onRefresh?.();
    } catch {}
  };

  const handleSaveEdit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (saving) return;
    setSaving(true);
    try {
      await apiPut(`/tasks/${task.id}`, {
        prompt: editPrompt,
        priority: editPriority,
      });
      setEditing(false);
      onRefresh?.();
    } catch {}
    finally { setSaving(false); }
  };

  const timeAgo = (iso: string) => {
    const ms = Date.now() - new Date(iso + 'Z').getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  return (
    <div
      className={`
        relative rounded border backdrop-blur-sm overflow-hidden cursor-pointer
        bg-gradient-to-br from-slate-900/80 to-slate-950/90
        ${cfg.borderClass}
        transition-all duration-200
        hover:border-slate-600/50
      `}
      style={{
        animationDelay: `${index * 60}ms`,
        animation: 'taskIn 0.35s ease-out both',
      }}
      onClick={() => { if (!editing) setExpanded(!expanded); }}
    >
      {cfg.bgAccent && <div className={`absolute inset-0 ${cfg.bgAccent} pointer-events-none`} />}

      {task.status === 'blocked' && (
        <div
          className="absolute top-0 left-0 right-0 h-[3px] opacity-40"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, #f59e0b 0px, #f59e0b 6px, transparent 6px, transparent 12px)',
          }}
        />
      )}

      <div className="relative p-2.5 space-y-2">
        {/* Header */}
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1.5">
            <span className={`block h-1.5 w-1.5 rounded-full flex-shrink-0 ${cfg.dotClass}`} />
            <span className={`text-[9px] font-bold tracking-[0.15em] uppercase ${cfg.textClass}`}>
              {cfg.label}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {task.priority > 0 && (
              <span className="text-[9px] font-bold text-amber-500">P{task.priority}</span>
            )}
            <span className="text-[9px] text-slate-700">{expanded ? '▾' : '▸'}</span>
          </div>
        </div>

        {/* Prompt */}
        {editing ? (
          <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              rows={4}
              className="w-full px-2 py-1.5 rounded border border-slate-700 bg-slate-950 text-[11px] text-slate-200 font-mono resize-none focus:outline-none focus:border-emerald-500/40"
            />
            <div className="flex items-center gap-2">
              <label className="text-[9px] text-slate-600">Priority</label>
              <input
                type="number" min={0} max={10} value={editPriority}
                onChange={(e) => setEditPriority(parseInt(e.target.value, 10) || 0)}
                className="w-12 px-1.5 py-0.5 rounded border border-slate-700 bg-slate-950 text-[10px] text-slate-300 font-mono text-center focus:outline-none focus:border-emerald-500/40"
              />
              <div className="flex-1" />
              <button
                onClick={(e) => { e.stopPropagation(); setEditing(false); setEditPrompt(task.prompt); setEditPriority(task.priority); }}
                className="text-[9px] text-slate-500 hover:text-slate-300 px-2 py-0.5"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="text-[9px] font-semibold text-emerald-400 hover:text-emerald-300 border border-emerald-500/30 rounded px-2 py-0.5 transition-colors"
              >
                {saving ? '...' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <p className={`text-[11px] text-slate-300 leading-snug font-mono ${expanded ? '' : 'line-clamp-2'}`}>
            {task.prompt}
          </p>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <div className="flex items-center gap-2 min-w-0">
            {agentName ? (
              <button
                onClick={(e) => { e.stopPropagation(); navigate(`/agent/${task.agent_id}`); }}
                className="text-[9px] text-emerald-500/70 hover:text-emerald-400 transition-colors truncate max-w-[100px]"
                title={`Open ${agentName}`}
              >
                {agentName} →
              </button>
            ) : (
              <span className="text-[9px] text-slate-600 italic">unassigned</span>
            )}
            {depCount > 0 && (
              <span className="text-[9px] text-slate-600">{depCount} dep{depCount > 1 ? 's' : ''}</span>
            )}
            {depOfCount > 0 && (
              <span className="text-[9px] text-cyan-700">{depOfCount} next</span>
            )}
          </div>

          {task.status === 'failed' && !expanded && (
            <button onClick={handleRetry}
              className="text-[9px] font-semibold text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/40 rounded px-1.5 py-0.5 transition-colors">
              RETRY
            </button>
          )}
        </div>

        {/* Expanded detail */}
        {expanded && !editing && (
          <div className="pt-2 mt-2 border-t border-slate-800/40 space-y-2">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[9px]">
              <div>
                <span className="text-slate-600 uppercase tracking-wider">ID</span>
                <p className="text-slate-400 font-mono truncate" title={task.id}>{task.id}</p>
              </div>
              <div>
                <span className="text-slate-600 uppercase tracking-wider">Created</span>
                <p className="text-slate-400">{timeAgo(task.created_at)}</p>
              </div>
              <div>
                <span className="text-slate-600 uppercase tracking-wider">Priority</span>
                <p className="text-slate-400">{task.priority}</p>
              </div>
              <div>
                <span className="text-slate-600 uppercase tracking-wider">Agent</span>
                <p className="text-slate-400">{agentName ?? 'Auto'}</p>
              </div>
            </div>

            {depCount > 0 && (
              <div>
                <span className="text-[9px] text-slate-600 uppercase tracking-wider">Depends on</span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {task.dependencies!.map((depId) => (
                    <span key={depId} className="text-[8px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono border border-slate-700/40">
                      {depId.slice(-8)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {depOfCount > 0 && (
              <div>
                <span className="text-[9px] text-slate-600 uppercase tracking-wider">Blocks</span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {task.dependents!.map((depId) => (
                    <span key={depId} className="text-[8px] px-1.5 py-0.5 rounded bg-slate-800 text-cyan-500/60 font-mono border border-cyan-500/15">
                      {depId.slice(-8)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1">
              {task.status !== 'running' && (
                <button
                  onClick={(e) => { e.stopPropagation(); setEditing(true); setEditPrompt(task.prompt); setEditPriority(task.priority); }}
                  className="text-[9px] font-semibold text-slate-400 hover:text-slate-200 border border-slate-700/40 hover:border-slate-600 rounded px-2 py-0.5 transition-colors"
                >
                  EDIT
                </button>
              )}
              {(task.status === 'failed' || task.status === 'done' || task.status === 'blocked') && (
                <button onClick={handleRetry}
                  className="text-[9px] font-semibold text-emerald-400 hover:text-emerald-300 border border-emerald-500/20 hover:border-emerald-500/40 rounded px-2 py-0.5 transition-colors">
                  RETRY
                </button>
              )}
              {task.status === 'pending' && (
                <button
                  onClick={async (e) => { e.stopPropagation(); try { await apiPost('/dispatch'); onRefresh?.(); } catch {} }}
                  className="text-[9px] font-semibold text-amber-400 hover:text-amber-300 border border-amber-500/20 hover:border-amber-500/40 rounded px-2 py-0.5 transition-colors">
                  DISPATCH
                </button>
              )}
              {(task.status === 'pending' || task.status === 'blocked') && (
                <button onClick={handleCancel}
                  className="text-[9px] font-semibold text-red-500/50 hover:text-red-400 border border-red-500/10 hover:border-red-500/30 rounded px-2 py-0.5 transition-colors ml-auto">
                  CANCEL
                </button>
              )}
              {agentName && task.agent_id && (
                <button
                  onClick={(e) => { e.stopPropagation(); navigate(`/agent/${task.agent_id}`); }}
                  className="text-[9px] font-semibold text-emerald-500/60 hover:text-emerald-400 border border-emerald-500/15 hover:border-emerald-500/30 rounded px-2 py-0.5 transition-colors">
                  OPEN AGENT
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
