import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Agent, EffortLevel } from '../../types';
import { parseMention, parseSlashCommand, type ComposerMode, type SlashCommand } from '../../utils/command-center';

export type ComposerSend =
  | { kind: 'prompt'; agentId: string; text: string }
  | { kind: 'task'; agentId: string | null; prompt: string; model?: string; effort?: EffortLevel }
  | { kind: 'reply'; agentId: string; text: string; refTaskId?: string }
  | { kind: 'file'; agentId: string; file: File }
  | { kind: 'slash'; agentId: string; command: SlashCommand };

interface ComposerProps {
  agents: Agent[];
  /** '' = all (Task mode only: first free agent). */
  target: string;
  onTargetChange: (agentId: string) => void;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  replyTaskId: string | null;
  disabled?: boolean;
  /** Resolves true on success, or an error message to show under the box. */
  onSend: (send: ComposerSend) => Promise<true | string>;
}

const MODES: { id: ComposerMode; label: string }[] = [
  // "Ask" = type into the agent's terminal; its answer comes back as a reply (spec §5b)
  { id: 'prompt', label: 'Ask' },
  { id: 'task', label: 'Task' },
  { id: 'reply', label: 'Reply' },
  { id: 'file', label: 'File' },
];

const EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

export default function Composer(props: ComposerProps) {
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel | ''>('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currentAgent = props.agents.find((a) => a.id === props.target) ?? null;
  const agent = currentAgent;
  const locked = !!agent && agent.can_act === false;
  const needsAgent = props.mode !== 'task';
  const showPin = props.mode === 'task' && (!agent || (!agent.model && !agent.effort));

  function build(): ComposerSend | string {
    let trimmed = text.trim();
    let agent = currentAgent;
    // `@name …` sends to that agent and moves the chip there
    const mention = parseMention(trimmed, props.agents);
    if (mention) {
      agent = mention.agent;
      trimmed = mention.text;
      if (mention.agent.id !== props.target) props.onTargetChange(mention.agent.id);
      if (mention.agent.can_act === false) return `${mention.agent.name} is owned by ${mention.agent.owner ?? 'someone else'}`;
    }
    const slash = parseSlashCommand(trimmed);
    if (slash) {
      if (!slash.ok) return slash.error;
      if (!agent) return 'Pick an agent for slash commands';
      return { kind: 'slash', agentId: agent.id, command: slash.command };
    }
    if (needsAgent && !agent) return 'Pick an agent';
    if (props.mode === 'file') {
      if (!file) return 'Choose a file';
      return { kind: 'file', agentId: agent!.id, file };
    }
    if (!trimmed) return 'Type a message';
    switch (props.mode) {
      case 'prompt': return { kind: 'prompt', agentId: agent!.id, text: trimmed };
      case 'reply': return { kind: 'reply', agentId: agent!.id, text: trimmed, ...(props.replyTaskId ? { refTaskId: props.replyTaskId } : {}) };
      default: return {
        kind: 'task',
        agentId: agent?.id ?? null,
        prompt: trimmed,
        ...(showPin && model.trim() ? { model: model.trim() } : {}),
        ...(showPin && effort ? { effort } : {}),
      };
    }
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const send = build();
    if (typeof send === 'string') {
      setError(send);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await props.onSend(send);
      if (result === true) {
        setText('');
        setFile(null);
      } else {
        setError(result);
      }
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form aria-label="Composer" onSubmit={submit} className="flex flex-col gap-1.5 border-t border-slate-800/60 bg-slate-950 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <label className="sr-only" htmlFor="composer-target">Target</label>
        <select
          id="composer-target"
          value={props.target}
          onChange={(e) => props.onTargetChange(e.target.value)}
          className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-xs text-slate-200"
        >
          <option value="">@all</option>
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.name}{a.orchestrator ? ' · seat' : ''}{a.can_act === false ? ` 🔒 ${a.owner ?? ''}` : ''}
            </option>
          ))}
        </select>
        <div role="radiogroup" aria-label="Mode" className="flex overflow-hidden rounded-full border border-slate-700">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={props.mode === m.id}
              onClick={() => props.onModeChange(m.id)}
              className={`px-2 py-0.5 text-xs ${props.mode === m.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {showPin && (
          <>
            <input
              aria-label="Model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model"
              className="w-24 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-200"
            />
            <select
              aria-label="Effort"
              value={effort}
              onChange={(e) => setEffort(e.target.value as EffortLevel | '')}
              className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-xs text-slate-200"
            >
              <option value="">effort</option>
              {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </>
        )}
        {props.mode === 'reply' && props.replyTaskId && (
          <span className="text-[11px] text-slate-500">re: task {props.replyTaskId.slice(-6)}</span>
        )}
      </div>
      {locked && (
        <p role="note" className="text-[11px] text-amber-400">🔒 {agent!.name} is owned by {agent!.owner ?? 'someone else'} — read-only for you.</p>
      )}
      <div className="flex items-end gap-2">
        {props.mode === 'file' ? (
          <input
            aria-label="File"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="flex-1 text-xs text-slate-300"
          />
        ) : (
          <textarea
            aria-label="Message"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={props.mode === 'task'
              ? 'Describe the task… (/reserve 4h, /release, /kill, /review, /promote, /retry)'
              : `Ask ${agent ? agent.name : 'an agent'}… (@name to send elsewhere)`}
            className="min-h-[2.25rem] flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-600"
          />
        )}
        <button
          type="submit"
          disabled={busy || props.disabled || locked}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
      {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}
    </form>
  );
}
