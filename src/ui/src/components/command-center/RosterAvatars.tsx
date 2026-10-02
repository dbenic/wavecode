/**
 * The Roster on narrow desktops (≤1100px, spec §4.4): one avatar per agent —
 * initial in the lease holder's color, status dot — click focuses its thread.
 */

import type { Agent, User } from '../../types';
import { userColor } from '../../utils/command-center';
import { handleOf } from '../../utils/composer-grammar';

interface RosterAvatarsProps {
  agents: Agent[];
  users: Map<string, User>;
  focusedAgentId: string | null;
  onFocus: (agentId: string | null) => void;
}

const STATUS_DOT: Record<Agent['status'], string> = {
  idle: 'bg-slate-500',
  working: 'bg-emerald-400',
  error: 'bg-red-500',
};

export default function RosterAvatars({ agents, users, focusedAgentId, onFocus }: RosterAvatarsProps) {
  return (
    <nav aria-label="Roster (compact)" className="flex flex-col items-center gap-2 py-3">
      <button
        type="button"
        onClick={() => onFocus(null)}
        title="All agents"
        aria-label="All agents"
        className={`h-8 w-8 rounded-full border text-[10px] ${focusedAgentId === null ? 'border-emerald-400 text-emerald-300' : 'border-slate-700 text-slate-500'}`}
      >
        all
      </button>
      {[...agents].sort((a, b) => handleOf(a).localeCompare(handleOf(b))).map((agent) => {
        const handle = handleOf(agent);
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => onFocus(agent.id)}
            title={`@${handle} · ${agent.status}${agent.owner ? ` · ${agent.owner}` : ''}`}
            aria-label={`@${handle}`}
            className={`relative flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold uppercase text-slate-100 ${focusedAgentId === agent.id ? 'border-emerald-400' : 'border-slate-800'}`}
            style={{ backgroundColor: agent.owner_id ? userColor(users, agent.owner_id) : '#1e293b' }}
          >
            {handle.slice(0, 2)}
            <span aria-hidden className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-slate-950 ${STATUS_DOT[agent.status]}`} />
          </button>
        );
      })}
    </nav>
  );
}
