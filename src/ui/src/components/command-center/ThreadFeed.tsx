import { useEffect, useRef, useState } from 'react';
import type { ThreadAction, ThreadItem, ThreadKind, User } from '../../types';
import { agentColor, userColor } from '../../utils/command-center';

interface ThreadFeedProps {
  items: ThreadItem[];
  users: Map<string, User>;
  agentNames: Map<string, string>;
  /** agent id → one-line persona, shown on reply bubbles (spec §5c) */
  personas?: Map<string, string>;
  /** agent id → bubble color override: a seat speaks in its user's color (spec §5d) */
  agentColors?: Map<string, string>;
  /** 👍/👎 (+ optional note) on a reply (spec §5f) */
  onFeedback?: (item: ThreadItem, score: 1 | -1, note?: string) => void;
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
  reply: 'text-emerald-300',
  command: 'text-fuchsia-300',
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
        {visible.map((item) => item.kind === 'reply' ? (
          <ReplyBubble
            key={item.id}
            item={item}
            agentName={item.agent_id ? props.agentNames.get(item.agent_id) ?? item.agent_id : 'agent'}
            persona={item.agent_id ? props.personas?.get(item.agent_id) ?? null : null}
            color={item.agent_id ? props.agentColors?.get(item.agent_id) : undefined}
            onFeedback={props.onFeedback}
            onAction={props.onAction}
          />
        ) : (
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

/**
 * A captured agent reply as a chat bubble (spec §5b): agent name and color,
 * time, the prose, and quick-reply chips when it ends with a question and
 * `[ ] option` lines. Tapping a chip sends that option back to the seat.
 */
function ReplyBubble({ item, agentName, persona, color: colorOverride, onAction, onFeedback }: {
  item: ThreadItem;
  agentName: string;
  persona?: string | null;
  color?: string;
  onFeedback?: (item: ThreadItem, score: 1 | -1, note?: string) => void;
  onAction: (item: ThreadItem, action: ThreadAction) => void;
}) {
  const color = colorOverride ?? agentColor(agentName);
  const chips = item.actions.filter((a) => a.id === 'quick_reply');
  const other = item.actions.filter((a) => a.id !== 'quick_reply');
  // The options are shown as chips; drop their `[ ]` lines from the prose.
  const body = chips.length > 0
    ? (item.body ?? '').split('\n').filter((l) => !/^\s*(?:[-*]\s+)?\[\s?\]\s+/.test(l) && !/^\s*(?:\[[^\]]+\]\s*){2,4}$/.test(l)).join('\n').trimEnd()
    : item.body;
  return (
    <li data-testid={`thread-item-${item.event_id}`} className="flex flex-col items-start">
      <div
        className={`max-w-[92%] rounded-2xl rounded-tl-sm border-l-4 bg-slate-900 px-3 py-2 ${item.needs_attention ? 'ring-1 ring-amber-500/40' : ''}`}
        style={{ borderLeftColor: color }}
      >
        <div className="mb-0.5 flex items-baseline gap-2 text-xs">
          <span className="font-semibold" style={{ color }}>{agentName}</span>
          {persona && <span className="italic text-slate-500">{persona}</span>}
          <span className="tabular-nums text-slate-600">{time(item.at)}</span>
          {item.title !== 'Reply' && <span className="text-amber-400">{item.title.replace(/^Reply\s*/, '')}</span>}
        </div>
        {body && <p className="whitespace-pre-wrap break-words text-sm text-slate-100">{body}</p>}
      </div>
      {chips.length > 0 && (
        <div role="group" aria-label="Quick replies" className="mt-1 flex flex-wrap gap-1.5 pl-1">
          {chips.map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => onAction(item, chip)}
              className="rounded-full border px-2.5 py-0.5 text-xs text-slate-100 hover:bg-slate-800"
              style={{ borderColor: color }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
      {item.feedback?.can_vote && onFeedback && <FeedbackBar item={item} onFeedback={onFeedback} />}
      {other.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5 pl-1">
          {other.map((action) => (
            <button key={action.id} type="button" onClick={() => onAction(item, action)} className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300">
              {action.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

/** 👍 / 👎 under a reply; 👎 asks for an optional "better: …" note (spec §5f). */
function FeedbackBar({ item, onFeedback }: { item: ThreadItem; onFeedback: (item: ThreadItem, score: 1 | -1, note?: string) => void }) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const fb = item.feedback!;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-1 text-xs">
      <button
        type="button"
        aria-label="Helpful"
        aria-pressed={fb.mine === 1}
        onClick={() => onFeedback(item, 1)}
        className={`rounded px-1.5 py-0.5 ${fb.mine === 1 ? 'bg-emerald-600/30 text-emerald-200' : 'text-slate-500 hover:text-slate-300'}`}
      >
        👍{fb.up > 0 ? ` ${fb.up}` : ''}
      </button>
      <button
        type="button"
        aria-label="Not helpful"
        aria-pressed={fb.mine === -1}
        onClick={() => setNoteOpen(true)}
        className={`rounded px-1.5 py-0.5 ${fb.mine === -1 ? 'bg-red-600/30 text-red-200' : 'text-slate-500 hover:text-slate-300'}`}
      >
        👎{fb.down > 0 ? ` ${fb.down}` : ''}
      </button>
      {fb.mine_note && !noteOpen && <span className="italic text-slate-500">“{fb.mine_note}”</span>}
      {noteOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onFeedback(item, -1, note.trim() || undefined);
            setNoteOpen(false);
            setNote('');
          }}
          className="flex items-center gap-1"
        >
          <input
            aria-label="Better:"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="better: … (optional)"
            maxLength={500}
            className="w-48 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-100"
          />
          <button type="submit" className="rounded border border-slate-600 px-1.5 py-0.5 text-slate-300">Send</button>
        </form>
      )}
    </div>
  );
}
