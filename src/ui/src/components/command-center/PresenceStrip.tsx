import type { Agent, User } from '../../types';
import { presence } from '../../utils/command-center';

interface PresenceStripProps {
  users: User[];
  agents: Agent[];
  me: User | null;
  onStopAll: () => void;
}

export default function PresenceStrip({ users, agents, me, onStopAll }: PresenceStripProps) {
  return (
    <div className="flex items-center gap-3 overflow-x-auto border-b border-slate-800/60 px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600">Presence</span>
      <ul aria-label="Presence" className="flex items-center gap-3">
        {presence(users, agents).map(({ user, agentCount, active }) => (
          <li key={user.id} className={`flex items-center gap-1 text-xs ${active ? 'text-slate-200' : 'text-slate-600'}`}>
            <span
              aria-hidden
              className={`block h-2 w-2 rounded-full ${active ? '' : 'border border-slate-600'}`}
              style={active ? { backgroundColor: user.color } : undefined}
            />
            {user.name}{active ? `(${agentCount})` : ''}{user.id === me?.id ? ' · you' : ''}
          </li>
        ))}
      </ul>
      {me?.role === 'admin' && (
        <button
          type="button"
          onClick={onStopAll}
          className="ml-auto shrink-0 rounded border border-red-500/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] text-red-400 hover:bg-red-500/10"
        >
          Stop all
        </button>
      )}
    </div>
  );
}
