import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import LiveTerminal from '../components/LiveTerminal';
import StatusBadge from '../components/StatusBadge';
import { apiGet, apiPost } from '../hooks/useApi';
import { useSSE, type SSEEvent } from '../hooks/useSSE';
import type { Agent } from '../types';

/**
 * The agent's pane as the whole viewport: what `ssh` + `tmux attach` shows,
 * read-only, with a one-line composer underneath. 'Screen' fit shrinks the
 * font until every row of the pane is visible; 'Width' keeps it readable and
 * lets the page scroll.
 */
const RAW_KEYS: Array<{ label: string; key: string }> = [
  { label: 'Esc', key: 'Escape' },
  { label: 'Enter', key: 'Enter' },
  { label: '↑', key: 'Up' },
  { label: '↓', key: 'Down' },
  { label: 'Tab', key: 'Tab' },
  { label: 'y', key: 'y' },
  { label: 'n', key: 'n' },
  { label: 'Ctrl-C', key: 'C-c' },
];

export default function TerminalFull() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [fit, setFit] = useState<'screen' | 'width'>('screen');
  /** null = fit automatically; a number = that many px, the pane scrolls as needed. */
  const [fontSize, setFontSize] = useState<number | null>(null);
  const stepFont = (delta: number) => setFontSize((cur) => Math.max(6, Math.min(32, (cur ?? 12) + delta)));
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try { setAgent(await apiGet<Agent>(`/agents/${id}`)); } catch (e) { setNote((e as Error).message); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // The page is the pane: keyboard shortcuts for text size (Ctrl/Cmd with - = 0).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); stepFont(1); }
      else if (e.key === '-') { e.preventDefault(); stepFont(-1); }
      else if (e.key === '0') { e.preventDefault(); setFontSize(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useSSE((ev: SSEEvent) => {
    if (ev.entityType === 'agent' && ev.entityId === id && ev.type !== 'agent.output') void load();
  });

  const send = async (payload: { text: string; raw?: boolean }) => {
    if (!id || sending) return;
    setSending(true);
    setNote(null);
    try {
      await apiPost(`/agents/${id}/send`, payload);
      if (!payload.raw) setText('');
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (!id) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#070b14] text-slate-300" data-testid="terminal-full">
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-slate-800/60 bg-slate-950/90 text-[10px] tracking-wider">
        <Link to={`/agent/${id}`} className="text-slate-500 hover:text-slate-200">← AGENT</Link>
        <span className="font-mono text-slate-200">{agent?.name ?? id}</span>
        {agent?.alias && <span className="text-cyan-500/80">@{agent.alias}</span>}
        {agent && <StatusBadge status={agent.status} />}
        {agent?.tmux_session && <span className="hidden sm:inline font-mono text-slate-600">{agent.tmux_session}</span>}
        <span className="ml-auto flex items-center gap-1 uppercase">
          <span className="text-slate-600">text</span>
          <button type="button" onClick={() => stepFont(-1)} className="px-2 py-0.5 rounded text-slate-400 hover:text-slate-100 font-mono" title="smaller text">A−</button>
          <span className="font-mono text-slate-500 normal-case">{fontSize ? `${fontSize}px` : 'auto'}</span>
          <button type="button" onClick={() => stepFont(1)} className="px-2 py-0.5 rounded text-slate-400 hover:text-slate-100 font-mono" title="larger text">A+</button>
          {fontSize && (
            <button type="button" onClick={() => setFontSize(null)} className="px-2 py-0.5 rounded text-slate-500 hover:text-slate-200" title="fit the text automatically again">auto</button>
          )}
          <span className="ml-3 text-slate-600">fit</span>
          {(['screen', 'width'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setFit(v)}
              className={`px-2 py-0.5 rounded ${fit === v ? 'bg-cyan-500/15 text-cyan-200' : 'text-slate-600 hover:text-slate-300'}`}
            >
              {v}
            </button>
          ))}
        </span>
      </div>

      {fit === 'screen' && !fontSize ? (
        <LiveTerminal key={`${id}-screen`} agentId={id} fit="screen" bare onUnavailable={(r) => setNote(r)} />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <LiveTerminal key={`${id}-width`} agentId={id} fit="width" bare fontSize={fontSize} onUnavailable={(r) => setNote(r)} />
        </div>
      )}

      {note && <div className="px-3 py-1 text-[10px] text-amber-300/80 border-t border-amber-500/10">{note}</div>}

      <form
        className="flex items-center gap-2 px-2 py-1.5 border-t border-slate-800/60 bg-slate-950/90"
        onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send({ text }); }}
      >
        <div className="hidden sm:flex items-center gap-1">
          {RAW_KEYS.map((k) => (
            <button
              key={k.key}
              type="button"
              disabled={sending}
              onClick={() => void send({ text: k.key, raw: true })}
              className="px-1.5 py-0.5 rounded border border-slate-800 text-[10px] font-mono text-slate-500 hover:text-slate-200 hover:border-slate-600"
              title={`send ${k.key}`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="type a prompt, Enter sends"
          className="flex-1 min-w-0 bg-slate-900/80 border border-slate-800 rounded px-2 py-1 text-[12px] font-mono text-slate-200 placeholder:text-slate-700 focus:outline-none focus:border-cyan-600/60"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="px-3 py-1 rounded bg-cyan-500/15 text-cyan-200 text-[10px] tracking-wider uppercase disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}
