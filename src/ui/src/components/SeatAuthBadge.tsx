import type { Agent } from '../types';

/**
 * How a seat is paid for, and whether it is in rotation (1 Nov 2026 policy: no seat uses any API
 * key; a seat under the plan floor or without a login is out until that changes).
 *
 *   `Max 62%`      green   subscription, plan window comfortably left
 *   `Max 12%`      amber   subscription, under 20 % left
 *   `OUT · 3%`     red     under the floor: parked until the window resets
 *   `LOGGED OUT`   red     no login on the profile: parked until someone logs it in
 *   `API KEY`      red     a provider key was found: pane killed, seat parked
 *   `KEY IN ENV`   amber   a key sits in the pane environment but the CLI rejected it (a restart clears it)
 *   `auth ?`       grey    not probed yet, or a key-based runtime
 */
export type SeatAuthInfo = Pick<Agent, 'auth' | 'out' | 'usage' | 'subscription'>;

export function seatAuthLabel(agent: SeatAuthInfo): { label: string; tone: 'green' | 'amber' | 'red' | 'grey'; title: string } {
  const out = agent.out ?? null;
  const auth = agent.auth ?? null;
  if (out?.reason === 'key') return { label: 'API KEY', tone: 'red', title: `Out of rotation: ${out.detail}. Nobody runs on a key; the pane was stopped.` };
  if (out?.reason === 'login') return { label: 'LOGGED OUT', tone: 'red', title: `Out of rotation: ${out.detail}. Log the profile in to bring the seat back.` };
  const weekly = agent.usage?.metrics?.find((m) => m.label === 'weekly')?.left_pct ?? null;
  const fiveH = agent.usage?.metrics?.find((m) => m.label === '5h')?.left_pct ?? null;
  const left = [weekly, fiveH].filter((v): v is number => typeof v === 'number');
  const min = left.length ? Math.min(...left) : null;
  if (out?.reason === 'quota') return { label: `OUT · ${min ?? '?'}%`, tone: 'red', title: `Out of rotation: ${out.detail}. Back when the window resets.` };
  const plan = shortPlan(auth?.plan ?? agent.subscription?.plan ?? null);
  if (auth?.env_key) return { label: `KEY IN ENV`, tone: 'amber', title: `${auth.detail ?? `${auth.env_key} in the pane environment`}. The CLI rejected it; a pane restart removes it.` };
  if (auth?.mode === 'subscription' || (!auth && plan)) {
    const pct = min !== null ? ` ${min}%` : '';
    return { label: `${plan ?? 'plan'}${pct}`, tone: min !== null && min < 20 ? 'amber' : 'green', title: `${auth?.plan ?? agent.subscription?.plan ?? 'subscription'}${min !== null ? `, ${min}% of the tightest window left` : ''}` };
  }
  return { label: 'auth ?', tone: 'grey', title: auth?.detail ?? 'not probed yet' };
}

function shortPlan(plan: string | null): string | null {
  if (!plan) return null;
  return plan.replace(/^Claude\s+/, '').replace(/^ChatGPT\s+/, 'GPT ').replace(/^Grok\s+/, '');
}

const TONE: Record<'green' | 'amber' | 'red' | 'grey', string> = {
  green: 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200',
  amber: 'border-amber-500/50 bg-amber-950/50 text-amber-200',
  red: 'border-red-500/60 bg-red-950/60 text-red-200 animate-pulse',
  grey: 'border-slate-700 bg-slate-900 text-slate-500',
};

export default function SeatAuthBadge({ agent, size = 'sm' }: { agent: SeatAuthInfo; size?: 'xs' | 'sm' }) {
  const { label, tone, title } = seatAuthLabel(agent);
  const text = size === 'xs' ? 'text-[8px] px-1 py-px' : 'text-[10px] px-1.5 py-px';
  return (
    <span className={`rounded border font-bold normal-case tracking-wide ${text} ${TONE[tone]}`} title={title} data-testid="seat-auth">
      {label}
    </span>
  );
}

/** One sentence for the agent page when the seat is out, plus what brings it back. */
export function seatOutSentence(agent: Pick<Agent, 'out' | 'profile' | 'name' | 'alias'>): string | null {
  const out = agent.out ?? null;
  if (!out) return null;
  const who = agent.alias ? `@${agent.alias}` : agent.name;
  if (out.reason === 'key') return `${who} is out of rotation: ${out.detail}. No seat runs on an API key; the pane was stopped. Remove the key, then relaunch.`;
  if (out.reason === 'login') return `${who} is out of rotation: ${out.detail}. Log the profile${agent.profile ? ` ${agent.profile}` : ''} in and the next probe brings it back.`;
  return `${who} is out of rotation: ${out.detail}. It is dispatched again when the window resets.`;
}
