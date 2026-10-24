/**
 * Config for the read-only Fable Queue monitor.
 * Defaults are the wavecode-countix bots. A config.yaml entry replaces a field.
 */

export interface FableBotConfig {
  id: string;
  /** tmux server socket (`tmux -L`). */
  socket: string;
  session: string;
  inbox: string;
  outbox: string;
  /**
   * Linux user for the pane read. When set, the command is
   * `sudo -n -u <run_as> tmux -L <socket> capture-pane -p -t <session>`.
   * Omitted means the collector's own user, with no sudo.
   */
  run_as?: string;
}

export interface FableQueueConfig {
  /** How often the collector captures panes and directories. Default 10. */
  poll_s?: number;
  /** A pending brief older than this raises an alert. Default 15. */
  pending_alert_min?: number;
  /** Pipeline cards. Default `#145`, `#134`, `B1`, `ENG-5`. */
  cards?: string[];
  /**
   * Extra directories of freeze notes and review result files.
   * `review.freeze_inbox` is always included.
   */
  note_dirs?: string[];
  bots?: FableBotConfig[];
}

export const DEFAULT_POLL_S = 10;
export const DEFAULT_PENDING_ALERT_MIN = 15;

export const DEFAULT_FABLE_CARDS = ['#145', '#134', 'B1', 'ENG-5'] as const;

/**
 * fable runs as ci: no sudo, inbox and outbox under /home/ci.
 * fable2..fable5 run as that Linux user. N is the socket, session, and inbox suffix.
 * Their outbox is /srv/fable/N/outbox. /home/ci/outbox-N is a symlink to it.
 */
export function defaultFableBots(): FableBotConfig[] {
  const bots: FableBotConfig[] = [{
    id: 'fable',
    socket: 'fable',
    session: 'claude-countix',
    inbox: '/home/ci/inbox',
    outbox: '/home/ci/outbox',
  }];
  for (const n of [2, 3, 4, 5]) {
    bots.push({
      id: `fable${n}`,
      socket: `fable${n}`,
      session: `claude-countix-${n}`,
      inbox: `/home/ci/inbox-${n}`,
      outbox: `/srv/fable/${n}/outbox`,
      run_as: `fable${n}`,
    });
  }
  return bots;
}

export interface ResolvedFableQueue {
  pollS: number;
  pendingAlertS: number;
  pendingAlertMin: number;
  cards: string[];
  noteDirs: string[];
  bots: FableBotConfig[];
}

export function resolveFableQueue(input: {
  fable_queue?: FableQueueConfig;
  review?: { freeze_inbox?: string[] };
} | null | undefined): ResolvedFableQueue {
  const raw = input?.fable_queue ?? {};
  const pollS = typeof raw.poll_s === 'number' && raw.poll_s >= 1 ? raw.poll_s : DEFAULT_POLL_S;
  const pendingAlertMin = typeof raw.pending_alert_min === 'number' && raw.pending_alert_min >= 0
    ? raw.pending_alert_min
    : DEFAULT_PENDING_ALERT_MIN;
  const cards = (raw.cards ?? [...DEFAULT_FABLE_CARDS]).map((c) => c.trim()).filter(Boolean);
  const bots = (raw.bots ?? defaultFableBots())
    .filter((b) => b.id.trim() && b.session.trim())
    .map((bot) => {
      const runAs = bot.run_as?.trim() ?? '';
      return runAs ? { ...bot, run_as: runAs } : { ...bot, run_as: undefined };
    });
  const noteDirs = [...(input?.review?.freeze_inbox ?? []), ...(raw.note_dirs ?? [])]
    .map((d) => d.trim())
    .filter(Boolean);
  return {
    pollS,
    pendingAlertMin,
    pendingAlertS: pendingAlertMin * 60,
    cards,
    noteDirs: [...new Set(noteDirs)],
    bots,
  };
}
