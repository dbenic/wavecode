import { useState } from 'react';
import StatusBadge from '../StatusBadge';
import type { Agent, Task, User } from '../../types';
import { currentTaskTitle, groupRoster, leaseCountdown, userColor } from '../../utils/command-center';

export const TASK_DRAG_TYPE = 'application/x-wavecode-task';

interface RosterProps {
  agents: Agent[];
  tasks: Task[];
  me: User | null;
  users: Map<string, User>;
  focusedAgentId: string | null;
  now: number;
  onFocus: (agentId: string | null) => void;
  onReserve: (agent: Agent) => void;
  onRelease: (agent: Agent) => void;
  /** A board task was dropped onto this agent. */
  onAssign: (taskId: string, agent: Agent) => void;
  /** Set alias / persona (spec §5c). */
  onRename?: (agent: Agent) => void;
}

export default function Roster(props: RosterProps) {
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const tags = [...new Set(props.agents.flatMap((a) => a.tags ?? []))].sort();
  const shown = tagFilter ? props.agents.filter((a) => a.tags?.includes(tagFilter)) : props.agents;
  const groups = groupRoster(shown, props.me?.id ?? null);
  return (
    <nav aria-label="Roster" className="flex flex-col gap-4 p-3">
      {tags.length > 0 && (
        <div role="group" aria-label="Filter by tag" className="flex flex-wrap gap-1">
          {[null, ...tags].map((tag) => (
            <button
              key={tag ?? '*'}
              type="button"
              aria-pressed={tagFilter === tag}
              onClick={() => setTagFilter(tag)}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${tagFilter === tag ? 'border-emerald-500 text-emerald-300' : 'border-slate-700 text-slate-400'}`}
            >
              {tag ? `#${tag}` : 'all tags'}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => props.onFocus(null)}
        className={`text-left text-[11px] font-semibold uppercase tracking-[0.2em] ${props.focusedAgentId === null ? 'text-emerald-400' : 'text-slate-500 hover:text-slate-300'}`}
      >
        All agents
      </button>
      <RosterGroup {...props} title="Mine" agents={groups.mine} />
      <RosterGroup {...props} title="Free" agents={groups.free} />
      <RosterGroup {...props} title="Team" agents={groups.team} />
    </nav>
  );
}

function RosterGroup({ title, agents, ...props }: RosterProps & { title: string }) {
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600">{title}</h3>
      {agents.length === 0 ? (
        <p className="text-xs text-slate-700">—</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {agents.map((agent) => (
            <RosterRow key={agent.id} agent={agent} {...props} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RosterRow({ agent, ...props }: Omit<RosterProps, 'agents'> & { agent: Agent }) {
  const focused = props.focusedAgentId === agent.id;
  const isMine = !!agent.owner_id && agent.owner_id === props.me?.id;
  const isAdmin = props.me?.role === 'admin';
  const canMutate = props.me?.role !== 'observer';
  const locked = !!agent.owner_id && !isMine && !isAdmin;
  const countdown = leaseCountdown(agent.lease_expires_at, props.now);
  const task = currentTaskTitle(agent, props.tasks);

  return (
    <li
      data-testid={`roster-${agent.name}`}
      onDragOver={(e) => {
        if (!locked && e.dataTransfer.types.includes(TASK_DRAG_TYPE)) e.preventDefault();
      }}
      onDrop={(e) => {
        const taskId = e.dataTransfer.getData(TASK_DRAG_TYPE);
        if (taskId && !locked) {
          e.preventDefault();
          props.onAssign(taskId, agent);
        }
      }}
      className={`rounded-lg border px-2 py-1.5 ${focused ? 'border-emerald-500/60 bg-slate-900' : 'border-slate-800/60 bg-slate-900/40'}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="block h-2.5 w-2.5 shrink-0 rounded-full border border-slate-700"
          style={agent.owner_id ? { backgroundColor: userColor(props.users, agent.owner_id) } : undefined}
        />
        <button
          type="button"
          onClick={() => props.onFocus(agent.id)}
          className="min-w-0 flex-1 truncate text-left text-sm text-slate-200 hover:text-white"
        >
          {locked && <span aria-label="locked" className="mr-1">🔒</span>}
          {agent.alias ? <>@{agent.alias} <span className="text-xs text-slate-500">{agent.name}</span></> : agent.name}
          {agent.owner && !isMine && <span className="ml-1 text-xs text-slate-500">({agent.owner})</span>}
          {!agent.owner_id && agent.profile_compatible === false && (
            <span className="ml-1 text-xs text-slate-500">(free · other subscription)</span>
          )}
        </button>
        <StatusBadge status={agent.status} />
      </div>
      {(agent.persona || (agent.tags?.length ?? 0) > 0) && (
        <div className="mt-0.5 flex flex-wrap items-center gap-1 pl-4 text-[11px] text-slate-400">
          {agent.persona && <span className="italic">{agent.persona}</span>}
          {agent.tags?.map((t) => <span key={t} className="rounded bg-slate-800 px-1 text-[10px] text-slate-400">#{t}</span>)}
        </div>
      )}
      {(task || countdown) && (
        <div className="mt-0.5 flex items-center gap-2 pl-4 text-[11px] text-slate-500">
          {task && <span className="truncate">{task}</span>}
          {countdown && <span className="ml-auto shrink-0 tabular-nums" title="Lease time left">⏱ {countdown}</span>}
        </div>
      )}
      {canMutate && (
        <div className="mt-1 flex gap-2 pl-4">
          {!agent.owner_id && agent.profile_compatible !== false && (
            <button type="button" onClick={() => props.onReserve(agent)} className="text-[10px] font-semibold uppercase tracking-[0.15em] text-sky-400 hover:text-sky-300">
              Reserve
            </button>
          )}
          {agent.owner_id && (isMine || isAdmin) && (
            <button type="button" onClick={() => props.onRelease(agent)} className="text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-400 hover:text-amber-300">
              Release
            </button>
          )}
          {props.onRename && !locked && (
            <button type="button" onClick={() => props.onRename?.(agent)} className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-400 hover:text-slate-200">
              Rename
            </button>
          )}
        </div>
      )}
    </li>
  );
}
