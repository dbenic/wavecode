import { useNavigate } from 'react-router-dom';
import type { Agent } from '../types';
import StatusBadge from './StatusBadge';

const RUNTIME_ICONS: Record<string, string> = {
  'claude-code': 'C',
  codex: 'X',
  aider: 'A',
  'aider-qwen': 'Q',
  'aider-deepseek': 'D',
  'aider-gpt-oss': 'G',
  'aider-custom': 'L',
};

const RUNTIME_COLORS: Record<string, string> = {
  'claude-code': 'from-amber-500/20 to-orange-600/10 border-amber-500/30',
  codex: 'from-cyan-500/20 to-blue-600/10 border-cyan-500/30',
  aider: 'from-violet-500/20 to-purple-600/10 border-violet-500/30',
  'aider-qwen': 'from-blue-500/20 to-indigo-600/10 border-blue-500/30',
  'aider-deepseek': 'from-teal-500/20 to-emerald-600/10 border-teal-500/30',
  'aider-gpt-oss': 'from-rose-500/20 to-pink-600/10 border-rose-500/30',
  'aider-custom': 'from-slate-500/20 to-zinc-600/10 border-slate-500/30',
};

const STATUS_BORDER: Record<string, string> = {
  idle: 'border-slate-700/50',
  working: 'border-emerald-500/30 shadow-[0_0_20px_-5px_theme(colors.emerald.500/0.15)]',
  error: 'border-red-500/40 shadow-[0_0_20px_-5px_theme(colors.red.500/0.2)]',
};

function getUptime(createdAt: string): string {
  const created = new Date(createdAt + 'Z').getTime();
  const diff = Math.floor((Date.now() - created) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
}

export default function AgentCard({
  agent,
  index,
}: {
  agent: Agent;
  index: number;
}) {
  const navigate = useNavigate();

  const runtimeColor = RUNTIME_COLORS[agent.runtime] ?? RUNTIME_COLORS['claude-code'];
  const statusBorder = STATUS_BORDER[agent.status] ?? STATUS_BORDER.idle;
  const icon = RUNTIME_ICONS[agent.runtime] ?? '?';

  return (
    <button
      onClick={() => navigate(`/agent/${agent.id}`)}
      className={`
        group relative w-full text-left rounded-lg border backdrop-blur-sm
        bg-gradient-to-br from-slate-900/80 to-slate-950/90
        ${statusBorder}
        transition-all duration-300 ease-out
        hover:scale-[1.02] hover:border-slate-500/50
        hover:shadow-[0_4px_30px_-5px_rgba(0,0,0,0.5)]
        active:scale-[0.98]
        cursor-pointer
        overflow-hidden
      `}
      style={{
        animationDelay: `${index * 80}ms`,
        animation: 'cardIn 0.5s ease-out both',
      }}
    >
      {/* Scan-line overlay */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.05) 2px, rgba(255,255,255,0.05) 4px)',
        }}
      />

      {/* Working state: animated border glow */}
      {agent.status === 'working' && (
        <div className="absolute inset-0 rounded-lg opacity-40 animate-pulse bg-gradient-to-t from-emerald-500/5 to-transparent" />
      )}

      <div className="relative p-4 space-y-3">
        {/* Header: icon + name + status */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Runtime icon */}
            <div
              className={`
                flex-shrink-0 flex items-center justify-center
                w-8 h-8 rounded border text-xs font-bold
                bg-gradient-to-br ${runtimeColor}
              `}
            >
              {icon}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-100 truncate">
                {agent.name}
              </h3>
              <p className="text-[10px] text-slate-500 tracking-wide uppercase flex items-center gap-1">
                {agent.runtime} &middot; {agent.mode}
                {agent.lastOutputLine?.includes("don't ask") || agent.lastOutputLine?.includes('dontAsk') ? (
                  <span className="px-1 py-px rounded bg-emerald-900/50 border border-emerald-500/30 text-[8px] text-emerald-400 font-bold">AUTO</span>
                ) : agent.lastOutputLine?.includes('bypass permissions') || agent.lastOutputLine?.includes('bypassPermissions') ? (
                  <span className="px-1 py-px rounded bg-amber-900/50 border border-amber-500/30 text-[8px] text-amber-400 font-bold">BYPASS</span>
                ) : agent.lastOutputLine?.includes('accept edits') ? (
                  <span className="px-1 py-px rounded bg-cyan-900/50 border border-cyan-500/30 text-[8px] text-cyan-400 font-bold">EDITS</span>
                ) : null}
              </p>
            </div>
          </div>
          <StatusBadge status={agent.status} />
        </div>

        {/* Last output line */}
        <div className="rounded bg-black/30 border border-slate-800/50 px-2.5 py-2 min-h-[36px]">
          <p className="text-[11px] text-slate-400 font-mono leading-snug truncate">
            {agent.lastOutputLine || (
              <span className="text-slate-600 italic">No output captured</span>
            )}
          </p>
        </div>

        {/* Footer: uptime + session */}
        <div className="flex items-center justify-between text-[10px] text-slate-600">
          <span className="tracking-wide">
            UP {getUptime(agent.created_at)}
          </span>
          <span className="font-mono truncate max-w-[120px]">
            {agent.tmux_session}
          </span>
        </div>
      </div>

      {/* Bottom accent bar */}
      <div
        className={`h-[2px] w-full transition-opacity duration-300 ${
          agent.status === 'working'
            ? 'bg-gradient-to-r from-transparent via-emerald-500/60 to-transparent opacity-100'
            : agent.status === 'error'
              ? 'bg-gradient-to-r from-transparent via-red-500/60 to-transparent opacity-100'
              : 'bg-gradient-to-r from-transparent via-slate-700/40 to-transparent opacity-0 group-hover:opacity-100'
        }`}
      />
    </button>
  );
}
