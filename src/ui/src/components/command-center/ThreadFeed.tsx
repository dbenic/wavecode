import { useEffect, useRef } from 'react';
import type { ThreadAction, ThreadItem, ThreadKind, User } from '../../types';
import { userColor } from '../../utils/command-center';

interface ThreadFeedProps {
  items: ThreadItem[];
  users: Map<string, User>;
  agentNames: Map<string, string>;
  attentionOnly: boolean;
  onToggleAttention: () => void;
  attentionCount: number;
  focusLabel: string;
  onAction: (item: ThreadItem, action: ThreadAction) => void;
  /** GET-action output shown under an item (log text, metadata). */
  expanded: Record<string, string>;
  /** Folded live terminal tail for the focused agent (null = all agents). */
  terminal: { open: boolean; output: string | null; onToggle: () => void } | null;
}

const KIND_CLASS: Record<ThreadKind, string> = {
  prompt: 'text-sky-400',
  report: 'text-slate-300',
  request: 'text-amber-300',
  run: 'text-emerald-400',
  verdict: 'text-violet-300',
  task: 'text-slate-400',
  alert: 'text-red-400',
  artifact: 'text-cyan-300',
};

function time(at: string): string {
  const d = new Date(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ThreadFeed(props: ThreadFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const visible = props.attentionOnly ? props.items.filter((i) => i.needs_attention) : props.items;

  // Newest at the bottom: keep the latest item in view as the feed grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
  }, [visible.length]);

  return (
    <section aria-label="Thread" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-slate-800/60 px-3 py-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">Thread · {props.focusLabel}</h2>
        <button
          type="button"
          aria-pressed={props.attentionOnly}
          onClick={props.onToggleAttention}
          className={`ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] ${props.attentionOnly ? 'border-amber-400 text-amber-300' : 'border-slate-700 text-slate-400'}`}
        >
          Attention {props.attentionCount > 0 && <span className="text-amber-400">●{props.attentionCount}</span>}
        </button>
      </div>

      <ol className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
        {visible.length === 0 && (
          <li className="py-6 text-center text-xs text-slate-600">{props.attentionOnly ? 'Nothing needs you right now.' : 'No activity yet.'}</li>
        )}
        {visible.map((item) => (
          <li
            key={item.id}
            data-testid={`thread-item-${item.event_id}`}
            className={`rounded-lg border px-2.5 py-1.5 ${item.needs_attention ? 'border-amber-500/40 bg-amber-500/5' : 'border-slate-800/60 bg-slate-900/40'}`}
          >
            <div className="flex items-baseline gap-2 text-xs">
              <span className="shrink-0 tabular-nums text-slate-600">{time(item.at)}</span>
              <span className={`shrink-0 font-semibold uppercase tracking-wider ${KIND_CLASS[item.kind]}`}>{item.kind}</span>
              {item.agent_id && <span className="shrink-0 text-slate-500">{props.agentNames.get(item.agent_id) ?? item.agent_id}</span>}
              <span className="min-w-0 flex-1 truncate text-slate-200">{item.title}</span>
              {item.actor_id && (
                <span className="shrink-0 font-medium" style={{ color: userColor(props.users, item.actor_id) }}>
                  {props.users.get(item.actor_id)?.name ?? ''}
                </span>
              )}
            </div>
            {item.body && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">{item.body}</p>}
            {item.actions.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {item.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => props.onAction(item, action)}
                    className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-500 hover:text-white"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
            {props.expanded[item.id] && (
              <pre className="mt-1.5 max-h-60 overflow-auto rounded bg-slate-950 p-2 text-[11px] text-slate-400">{props.expanded[item.id]}</pre>
            )}
          </li>
        ))}
        <div ref={bottomRef} />
      </ol>

      {props.terminal && (
        <div className="border-t border-slate-800/60 px-3 py-1.5">
          <button type="button" aria-expanded={props.terminal.open} onClick={props.terminal.onToggle} className="text-[11px] text-slate-500 hover:text-slate-300">
            {props.terminal.open ? '▾' : '▸'} terminal tail
          </button>
          {props.terminal.open && (
            <pre data-testid="terminal-tail" className="mt-1 max-h-48 overflow-auto rounded bg-black/60 p-2 font-mono text-[11px] text-slate-300">
              {props.terminal.output ?? 'Loading…'}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
