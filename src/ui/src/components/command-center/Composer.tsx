import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Agent, EffortLevel, Task, User } from '../../types';
import { agentColor, currentTaskTitle, parseMention, parseSlashCommand, type ComposerMode, type SlashCommand } from '../../utils/command-center';
import { handleOf, parseComposer, suggestionsFor, tokenAt, type Plan, type Suggestion } from '../../utils/composer-grammar';

export type ComposerSend =
  | { kind: 'prompt'; agentId: string; text: string }
  | { kind: 'task'; agentId: string | null; prompt: string; model?: string; effort?: EffortLevel }
  | { kind: 'reply'; agentId: string; text: string; refTaskId?: string }
  | { kind: 'file'; agentId: string; file: File }
  | { kind: 'slash'; agentId: string; command: SlashCommand }
  /** Ask mode with the §5c grammar: fan-out, #commands, @all, @person */
  | { kind: 'plan'; plan: Plan };

interface ComposerProps {
  agents: Agent[];
  /** '' = all (Task mode only: first free agent). */
  target: string;
  onTargetChange: (agentId: string) => void;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  replyTaskId: string | null;
  disabled?: boolean;
  /** For `@person` and autocomplete (spec §5c). */
  users?: User[];
  /** For `#n` task references and autocomplete. */
  tasks?: Task[];
  /** Why Ask cannot go to the seat right now (spec §5d: a missing seat is offered for recreation, not silently replaced). */
  askBlocked?: string | null;
  /** Resolves true on success, or an error message to show under the box. */
  onSend: (send: ComposerSend) => Promise<true | string>;
}

const MODES: { id: ComposerMode; label: string }[] = [
  // "Ask" = a question for the orchestrator seat, which reads the agents and answers in prose;
  // the focused agent is passed as context. "Prompt" = raw text into the target's terminal.
  { id: 'ask', label: 'Ask' },
  { id: 'prompt', label: 'Prompt' },
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
  const [cursor, setCursor] = useState(0);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);

  const users = useMemo(() => props.users ?? [], [props.users]);
  const tasks = useMemo(() => props.tasks ?? [], [props.tasks]);
  const token = props.mode !== 'file' ? tokenAt(text, cursor) : null;
  const suggestions: Suggestion[] = token && dismissedAt !== text
    ? suggestionsFor(token.token, {
      agents: props.agents,
      users,
      tasks,
      colorFor: (a) => agentColor(a.name),
      currentTask: (a) => currentTaskTitle(a, tasks),
    })
    : [];

  function accept(s: Suggestion) {
    if (!token) return;
    const next = `${text.slice(0, token.start)}${s.insert} ${text.slice(cursor)}`;
    setText(next);
    setCursor(token.start + s.insert.length + 1);
    setActiveSuggestion(0);
  }

  const currentAgent = props.agents.find((a) => a.id === props.target) ?? null;
  const agent = currentAgent;
  const locked = !!agent && agent.can_act === false;
  const needsAgent = props.mode !== 'task';
  const showPin = props.mode === 'task' && (!agent || (!agent.model && !agent.effort));

  function build(): ComposerSend | string {
    let trimmed = text.trim();
    let agent = currentAgent;

    // Ask: explicit @/# addressing uses the grammar; anything else goes to the
    // orchestrator seat with the focused agent as context — the seat understands
    // the question and interprets the agent's terminal, the composer does not.
    if (props.mode === 'ask' && !trimmed.startsWith('/') && !trimmed.startsWith('@') && !trimmed.startsWith('#')) {
      if (props.askBlocked) return props.askBlocked;
      const seat = props.agents.find((a) => a.orchestrator) ?? null;
      if (seat) {
        if (!trimmed) return 'Type a question';
        if (seat.can_act === false) return `${handleOf(seat)} is owned by ${seat.owner ?? 'someone else'}`;
        const about = currentAgent && currentAgent.id !== seat.id ? `About @${handleOf(currentAgent)}: ` : '';
        return { kind: 'prompt', agentId: seat.id, text: `${about}${trimmed}` };
      }
      // No seat configured: behave like Prompt
    }

    // Ask/Prompt speak the §5c grammar (slash commands keep working)
    if ((props.mode === 'prompt' || props.mode === 'ask') && !trimmed.startsWith('/')) {
      const seat = props.agents.find((a) => a.orchestrator) ?? null;
      const plan = parseComposer(trimmed, { agents: props.agents, users, tasks, seat, chip: currentAgent });
      if (plan.kind === 'none') return plan.reason;
      if (plan.kind === 'prompt') {
        const locked = plan.agents.filter((a) => a.can_act === false);
        if (locked.length > 0) return locked.map((a) => `${handleOf(a)} is owned by ${a.owner ?? 'someone else'}`).join('; ');
        // `@x …` moves the chip to x
        if (trimmed.startsWith('@') && plan.agents.length === 1 && plan.agents[0].id !== props.target) {
          props.onTargetChange(plan.agents[0].id);
        }
        if (plan.agents.length === 1) return { kind: 'prompt', agentId: plan.agents[0].id, text: plan.text };
      }
      return { kind: 'plan', plan };
    }

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
      case 'ask':
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
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActiveSuggestion((i) => (i + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        accept(suggestions[Math.min(activeSuggestion, suggestions.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedAt(text);
        return;
      }
    }
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
              @{handleOf(a)}{a.orchestrator ? ' · seat' : ''}{a.can_act === false ? ` 🔒 ${a.owner ?? ''}` : ''}
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
      {suggestions.length > 0 && (
        <ul id="composer-suggestions" role="listbox" aria-label="Suggestions" className="max-h-48 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 py-1">
          {suggestions.map((sugg, i) => (
            <li
              key={sugg.insert}
              role="option"
              aria-selected={i === activeSuggestion}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(sugg);
              }}
              className={`flex cursor-pointer items-center gap-2 px-2 py-1 text-xs ${i === activeSuggestion ? 'bg-slate-800 text-white' : 'text-slate-300'}`}
            >
              {sugg.color && <span aria-hidden className="block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: sugg.color }} />}
              <span className="font-medium">{sugg.label}</span>
              <span className="truncate text-slate-500">{sugg.detail}</span>
            </li>
          ))}
        </ul>
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
            onChange={(e) => {
              setText(e.target.value);
              setCursor(e.target.selectionStart ?? e.target.value.length);
              setActiveSuggestion(0);
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? text.length)}
            onKeyDown={onKeyDown}
            aria-autocomplete="list"
            aria-controls={suggestions.length > 0 ? 'composer-suggestions' : undefined}
            placeholder={props.mode === 'task'
              ? 'Describe the task… (/reserve 4h, /release, /kill, /review, /promote, /retry)'
              : props.mode === 'ask'
                ? `Ask about ${agent ? handleOf(agent) : 'the team'}… (@name or #command to address an agent directly)`
                : `Prompt ${agent ? handleOf(agent) : 'an agent'}… (typed into its terminal)`}
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
