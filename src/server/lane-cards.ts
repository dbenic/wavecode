/**
 * One card per lane for the Reviews page. The latest freeze is the card.
 * Older freezes sit in its history. Wording is the next action, in plain words.
 */

import { SAME_OWNER_POOL_NOTE } from './reviewer-assign.js';

export type LaneOwnerKind = 'developer' | 'reviewer' | 'system' | 'denis';
export type PipeStepId = 'freeze' | 'tests' | 'review' | 'staging' | 'ready' | 'prod';
export type PipeMark = 'done' | 'current' | 'todo' | 'blocked';

export interface PipeStep {
  id: PipeStepId;
  label: string;
  mark: PipeMark;
  reason: string | null;
}

export interface LaneButton {
  kind: 'stage' | 'ready' | 'promote' | 'clear';
  label: string;
  run_id: string | null;
  sha: string;
  project: string | null;
  /** Set when kind is `clear`: the open staging request an admin may end. */
  release_id?: string | null;
}

export interface LaneLink {
  label: string;
  path: string;
}

export interface LaneOlder {
  sha: string;
  title: string;
  when: string;
}

export interface LaneCard {
  key: string;
  project: string | null;
  lane: string | null;
  title: string;
  desk: number | null;
  sha: string | null;
  status: string;
  action: string;
  owner: LaneOwnerKind;
  owner_label: string;
  needs_you: boolean;
  mine: boolean;
  history: boolean;
  button: LaneButton | null;
  pipeline: PipeStep[];
  older: LaneOlder[];
  link: LaneLink | null;
  version: string | null;
}

export interface ReleaseLane {
  lane: string | null;
  title: string;
  sha: string;
  version: string | null;
  desk: number | null;
}

export interface ReleaseTip {
  version: string | null;
  sha: string | null;
}

export interface ReleaseView {
  prod: ReleaseTip;
  staging: ReleaseTip;
  next_version: string | null;
  queued: ReleaseLane[];
}

export interface LaneFreezeFact {
  sha: string;
  project: string | null;
  lane: string | null;
  desk: number | null;
  title: string | null;
  summary: string | null;
  author_name: string | null;
  reviewer_name: string | null;
  verdict: string | null;
  verdict_path: string | null;
  created_at: string;
  state: string;
  version: string | null;
  behind_main: boolean;
  superseded: boolean;
  in_staging: boolean;
  in_prod: boolean;
  action: 'stage' | 'ready' | 'promote' | 'none';
  action_lock: string | null;
  run_id: string | null;
  run_backed: boolean;
  quick_running: boolean;
  eta_min: number | null;
  conflict_files: string[];
  auto_merge_main: boolean;
  auto_stage: boolean;
  reviewing_since: string | null;
  unknown_reason: string | null;
  live_at: string | null;
  /** The reviewer is the author's other seat, allowed only by the author-glob pool. */
  same_owner_pool?: boolean;
  /** An open staging request for this project. The card says so instead of offering Stage. */
  open_request_id?: string | null;
  open_request_at?: string | null;
  /** Admin viewer: the card may clear that request. */
  can_clear?: boolean;
}

export interface WorkingLaneFact {
  project: string;
  lane: string;
  sha: string;
  author_name: string | null;
  title: string | null;
  desk: number | null;
}

export interface LaneViewer {
  name: string | null;
  lanes: string[];
}

const STEPS: Array<[PipeStepId, string]> = [
  ['freeze', 'Freeze'],
  ['tests', 'Tests'],
  ['review', 'Review'],
  ['staging', 'Staging'],
  ['ready', 'Ready'],
  ['prod', 'Prod'],
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

function laneMatches(globs: string[], lane: string | null): boolean {
  if (!lane) return false;
  return globs.some((glob) => {
    try { return globToRe(glob.trim()).test(lane); } catch { return false; }
  });
}

export function conflictFilesFromNote(note: string | null): string[] {
  if (!note) return [];
  const match = note.match(/merge conflict in ([^—\n]+)/i);
  if (!match) return [];
  const names = match[1].split(',').map((part) => {
    const trimmed = part.trim().replace(/\\/g, '/');
    const base = trimmed.split('/').filter(Boolean).pop() ?? '';
    return base.replace(/^@/, '');
  }).filter((name) => name.length > 0 && !name.includes(' '));
  return [...new Set(names)].slice(0, 4);
}

function hhmm(iso: string | null): string | null {
  if (!iso) return null;
  const match = iso.match(/(?:T| )(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function stamp(iso: string | null): string | null {
  if (!iso) return null;
  const match = iso.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return null;
  return `${Number(match[3])} ${month} ${match[4]}:${match[5]}`;
}

function versionOf(version: string | null): string | null {
  if (!version) return null;
  const cleaned = version.trim().replace(/^v/i, '');
  return cleaned || null;
}

function looksLikePath(text: string): boolean {
  return text.includes('/') || text.startsWith('~');
}

function oneLine(text: string | null, fallback: string): string {
  const raw = (text ?? '').split('\n')[0]?.trim() ?? '';
  const stripped = raw.replace(/(^|\s)(~?\/(?:[\w.+-]+\/)+[\w.+-]+)/g, (_match, lead: string, path: string) => {
    const base = path.split('/').filter(Boolean).pop() ?? '';
    return `${lead}${base}`;
  }).replace(/\s+/g, ' ').trim();
  return stripped || fallback;
}

export function cardTitle(desk: number | null, title: string | null, lane: string | null): string {
  const clean = title && !looksLikePath(title) ? title.trim() : '';
  if (clean) {
    if (desk != null && !clean.includes(String(desk))) return `#${desk} ${clean}`;
    return clean;
  }
  if (desk != null) return `#${desk}`;
  const bare = (lane ?? '').replace(/^wc-/i, '').replace(/[-_]+/g, ' ').trim();
  return bare || 'Lane';
}

function ownerName(lane: string | null, owners: Array<{ name: string; lanes: string[] }>, author: string | null): string {
  if (lane) {
    const hit = owners.find((owner) => laneMatches(owner.lanes, lane));
    if (hit) return hit.name;
  }
  const name = author?.replace(/^@/, '').trim();
  if (!name) return 'developer';
  const byAuthor = owners.find((owner) => owner.name.toLowerCase() === name.toLowerCase());
  return byAuthor?.name ?? name;
}

function steps(current: PipeStepId, blocked: { id: PipeStepId; reason: string } | null): PipeStep[] {
  const order = STEPS.map(([id]) => id);
  const at = order.indexOf(blocked?.id ?? current);
  return STEPS.map(([id, label], index) => ({
    id,
    label,
    mark: blocked?.id === id ? 'blocked' : index < at ? 'done' : index === at ? 'current' : 'todo',
    reason: blocked?.id === id ? blocked.reason : null,
  }));
}

function allDone(): PipeStep[] {
  return STEPS.map(([id, label]) => ({ id, label, mark: 'done' as const, reason: null }));
}

interface Presented {
  status: string;
  action: string;
  owner: LaneOwnerKind;
  owner_label: string;
  history: boolean;
  button: LaneButton | null;
  pipeline: PipeStep[];
  link: LaneLink | null;
}

function buttonFor(fact: LaneFreezeFact, kind: LaneButton['kind'], label: string): LaneButton | null {
  if (fact.action_lock) return null;
  if (kind === 'stage' && (!fact.run_backed || !fact.run_id)) return null;
  if (kind === 'promote' && fact.action !== 'promote') return null;
  if (kind === 'ready' && fact.action !== 'ready') return null;
  if (kind === 'stage' && fact.action !== 'stage') return null;
  return { kind, label, run_id: fact.run_id, sha: fact.sha, project: fact.project };
}

function present(fact: LaneFreezeFact, who: string): Presented {
  const parked = fact.in_staging || fact.in_prod
    || fact.state === 'on_staging' || fact.state === 'live_on_prod' || fact.state === 'awaiting_prod_go';
  const link = fact.verdict_path ? { label: 'Read the verdict', path: fact.verdict_path } : null;

  if (fact.state === 'live_on_prod') {
    const version = versionOf(fact.version);
    const when = stamp(fact.live_at);
    const bits = [version, when].filter(Boolean);
    return {
      status: 'Live',
      action: bits.join(' · ') || 'On production',
      owner: 'system',
      owner_label: 'system',
      history: true,
      button: null,
      pipeline: allDone(),
      link: null,
    };
  }
  if (fact.state === 'superseded' || fact.superseded) {
    return {
      status: 'Superseded',
      action: 'A newer freeze replaced this one',
      owner: 'system',
      owner_label: 'system',
      history: true,
      button: null,
      pipeline: steps('freeze', { id: 'freeze', reason: 'Superseded' }),
      link: null,
    };
  }
  if (fact.state === 'stale') {
    return {
      status: 'Stale',
      action: 'This freeze is stale',
      owner: 'system',
      owner_label: 'system',
      history: true,
      button: null,
      pipeline: steps('freeze', { id: 'freeze', reason: 'Stale' }),
      link: null,
    };
  }
  if (fact.behind_main && !parked) {
    if (fact.conflict_files.length > 0) {
      const files = fact.conflict_files.join(', ');
      return {
        status: 'Behind main',
        action: `Resolve conflict in ${files}`,
        owner: 'developer',
        owner_label: who,
        history: false,
        button: null,
        pipeline: steps('freeze', { id: 'freeze', reason: `Conflict in ${files}` }),
        link: null,
      };
    }
    if (fact.auto_merge_main) {
      return {
        status: 'Behind main',
        action: 'Merging main automatically…',
        owner: 'developer',
        owner_label: who,
        history: false,
        button: null,
        pipeline: steps('freeze', { id: 'freeze', reason: 'Merging main' }),
        link: null,
      };
    }
    return {
      status: 'Behind main',
      action: 'Merge main and refreeze (agent notified)',
      owner: 'developer',
      owner_label: who,
      history: false,
      button: null,
      pipeline: steps('freeze', { id: 'freeze', reason: 'Behind main' }),
      link: null,
    };
  }
  if (fact.quick_running) {
    const eta = fact.eta_min != null && fact.eta_min > 0 ? fact.eta_min : null;
    return {
      status: 'Testing',
      action: eta ? `Quick check running, about ${eta} min` : 'Quick check running',
      owner: 'system',
      owner_label: 'system',
      history: false,
      button: null,
      pipeline: steps('tests', null),
      link: null,
    };
  }
  if (fact.state === 'needs_fixes' || fact.verdict === 'needs-fixes' || fact.verdict === 'reject') {
    const fromReviewer = fact.verdict === 'needs-fixes' || fact.verdict === 'reject';
    const summary = oneLine(fact.summary, fromReviewer ? 'The reviewer asked for fixes.' : 'The check on this SHA failed.');
    return {
      status: 'Needs fixes',
      action: summary,
      owner: 'developer',
      owner_label: `${who}'s agent`,
      history: false,
      button: null,
      pipeline: fromReviewer
        ? steps('review', { id: 'review', reason: summary })
        : steps('tests', { id: 'tests', reason: summary }),
      link,
    };
  }
  if (fact.open_request_at && fact.state !== 'on_staging' && fact.state !== 'live_on_prod') {
    const when = hhmm(fact.open_request_at);
    const action = when ? `Staging request open since ${when}` : 'Staging request open';
    const clear = fact.can_clear && fact.open_request_id
      ? { kind: 'clear' as const, label: 'Clear stuck request', run_id: fact.run_id, sha: fact.sha, project: fact.project, release_id: fact.open_request_id }
      : null;
    return {
      status: fact.state === 'ready_to_stage' ? 'Ready to stage' : 'Staging',
      action,
      owner: 'system',
      owner_label: 'system',
      history: false,
      button: clear,
      pipeline: steps('staging', { id: 'staging', reason: action }),
      link: null,
    };
  }
  if (fact.state === 'on_staging') {
    const locked = !!fact.action_lock;
    return {
      status: 'On staging',
      action: locked ? fact.action_lock! : 'Check it on staging, then press Ready for prod',
      owner: locked ? 'system' : 'developer',
      owner_label: locked ? 'system' : who,
      history: true,
      button: locked ? null : buttonFor(fact, 'ready', 'Ready for prod'),
      pipeline: locked
        ? steps('ready', { id: 'ready', reason: fact.action_lock! })
        : steps('ready', null),
      link: null,
    };
  }
  if (fact.state === 'awaiting_prod_go') {
    const version = versionOf(fact.version);
    const promote = buttonFor(fact, 'promote', 'Promote');
    return {
      status: 'Waiting for Denis',
      action: version ? `in release ${version}` : 'in the next release',
      owner: 'denis',
      owner_label: 'Denis',
      history: false,
      button: promote,
      pipeline: steps('prod', null),
      link: null,
    };
  }
  if (fact.state === 'ready_to_stage') {
    if (fact.auto_stage && !fact.action_lock) {
      return {
        status: 'Ready to stage',
        action: 'Staging automatically…',
        owner: 'system',
        owner_label: 'system',
        history: false,
        button: null,
        pipeline: steps('staging', null),
        link: null,
      };
    }
    const lock = fact.action_lock || (!fact.run_backed ? 'Stage needs a recorded run on this SHA' : null);
    return {
      status: 'Ready to stage',
      action: lock ?? 'Press Stage',
      owner: lock ? 'system' : 'developer',
      owner_label: lock ? 'system' : who,
      history: false,
      button: lock ? null : buttonFor(fact, 'stage', 'Stage'),
      pipeline: lock ? steps('staging', { id: 'staging', reason: lock }) : steps('staging', null),
      link: null,
    };
  }
  if (fact.state === 'awaiting_tests') {
    return {
      status: 'Testing',
      action: 'Waiting for the quick check',
      owner: 'system',
      owner_label: 'system',
      history: false,
      button: null,
      pipeline: steps('tests', null),
      link: null,
    };
  }
  if (fact.state === 'unknown') {
    const reason = oneLine(fact.action_lock || fact.unknown_reason, 'Deploy state is unknown');
    if (reason.startsWith('Stage locked:')) {
      return {
        status: 'Stage locked',
        action: reason,
        owner: 'system',
        owner_label: 'system',
        history: false,
        button: null,
        pipeline: steps('staging', { id: 'staging', reason }),
        link: null,
      };
    }
    return {
      status: 'Unknown',
      action: reason,
      owner: 'system',
      owner_label: 'system',
      history: false,
      button: null,
      pipeline: steps('freeze', { id: 'freeze', reason }),
      link: null,
    };
  }
  const since = hhmm(fact.reviewing_since) ?? hhmm(fact.created_at);
  const reviewer = fact.reviewer_name?.replace(/^@/, '').trim();
  const own = fact.same_owner_pool ? ` — ${SAME_OWNER_POOL_NOTE}` : '';
  if (reviewer) {
    return {
      status: 'In review',
      action: (since ? `${reviewer} reviewing since ${since}` : `${reviewer} reviewing`) + own,
      owner: 'reviewer',
      owner_label: reviewer,
      history: false,
      button: null,
      pipeline: steps('review', null),
      link: null,
    };
  }
  return {
    status: 'In review',
    action: 'Waiting for a reviewer',
    owner: 'system',
    owner_label: 'system',
    history: false,
    button: null,
    pipeline: steps('review', null),
    link: null,
  };
}

function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/^@/, '').trim().toLowerCase() === b.trim().toLowerCase();
}

function finish(fact: LaneFreezeFact, presented: Presented, older: LaneOlder[], viewer: LaneViewer | null, owners: Array<{ name: string; lanes: string[] }>): LaneCard {
  const who = ownerName(fact.lane, owners, fact.author_name);
  const shown = presented.owner === 'developer' || presented.owner_label.endsWith("'s agent")
    ? { ...presented, owner_label: presented.owner_label.endsWith("'s agent") ? `${who}'s agent` : who }
    : presented;
  const button = shown.button;
  return {
    key: `${fact.project ?? ''}:${fact.lane ?? fact.sha}`,
    project: fact.project,
    lane: fact.lane,
    title: cardTitle(fact.desk, fact.title, fact.lane),
    desk: fact.desk,
    sha: fact.sha,
    status: shown.status,
    action: shown.action,
    owner: shown.owner,
    owner_label: shown.owner_label,
    needs_you: !shown.history && (shown.owner === 'developer' || button?.kind === 'promote'),
    mine: viewer?.name ? laneMatches(viewer.lanes, fact.lane) || samePerson(fact.author_name, viewer.name) : false,
    history: shown.history,
    button,
    pipeline: shown.pipeline,
    older,
    link: shown.link,
    version: versionOf(fact.version),
  };
}

function workingCard(fact: WorkingLaneFact, viewer: LaneViewer | null, owners: Array<{ name: string; lanes: string[] }>, older: LaneOlder[]): LaneCard {
  const who = ownerName(fact.lane, owners, fact.author_name);
  return {
    key: `${fact.project}:${fact.lane}`,
    project: fact.project,
    lane: fact.lane,
    title: cardTitle(fact.desk, fact.title, fact.lane),
    desk: fact.desk,
    sha: fact.sha,
    status: 'Working',
    action: 'Nothing frozen yet',
    owner: 'developer',
    owner_label: who,
    needs_you: false,
    mine: viewer?.name ? laneMatches(viewer.lanes, fact.lane) : false,
    history: true,
    button: null,
    pipeline: steps('freeze', null),
    older,
    link: null,
    version: null,
  };
}

function rank(card: LaneCard): number {
  if (card.history) return 100;
  if (card.needs_you && card.status === 'Behind main') return 0;
  if (card.needs_you && card.status === 'Needs fixes') return 1;
  if (card.needs_you) return 2;
  if (card.status === 'Behind main') return 3;
  if (card.status === 'Needs fixes') return 4;
  if (card.status === 'On staging') return 5;
  if (card.status === 'Ready to stage') return 6;
  if (card.status === 'Working') return 7;
  if (card.status === 'In review') return 8;
  if (card.status === 'Testing') return 9;
  if (card.status === 'Waiting for Denis') return 10;
  return 11;
}

export function buildLaneCards(
  freezes: LaneFreezeFact[],
  working: WorkingLaneFact[],
  viewer: LaneViewer | null,
  owners: Array<{ name: string; lanes: string[] }>,
): LaneCard[] {
  const groups = new Map<string, LaneFreezeFact[]>();
  for (const fact of freezes) {
    const key = fact.lane ? `${fact.project ?? ''}:${fact.lane}` : `sha:${fact.sha}`;
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }
  const cards: LaneCard[] = [];
  const covered = new Set<string>();
  for (const [key, list] of groups) {
    list.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const [latest, ...rest] = list;
    if (!latest) continue;
    const olderOf = (rows: LaneFreezeFact[]): LaneOlder[] => rows.map((row) => ({
      sha: row.sha,
      title: cardTitle(row.desk, row.title, row.lane),
      when: stamp(row.created_at) ?? row.created_at,
    }));
    const laneKey = latest.lane ? `${latest.project ?? ''}:${latest.lane}` : key;
    covered.add(laneKey);
    const tip = working.find((row) => `${row.project}:${row.lane}` === laneKey);
    const latestHistory = latest.state === 'live_on_prod' || latest.state === 'superseded' || latest.state === 'stale' || latest.superseded;
    if (tip && latestHistory) {
      cards.push(workingCard(tip, viewer, owners, olderOf(list)));
      continue;
    }
    const who = ownerName(latest.lane, owners, latest.author_name);
    cards.push(finish(latest, present(latest, who), olderOf(rest), viewer, owners));
  }
  for (const tip of working) {
    const laneKey = `${tip.project}:${tip.lane}`;
    if (covered.has(laneKey)) continue;
    cards.push(workingCard(tip, viewer, owners, []));
  }
  return cards.sort((a, b) => rank(a) - rank(b));
}

export function buildReleaseView(cards: LaneCard[], tips: { prod: ReleaseTip; staging: ReleaseTip }): ReleaseView {
  const queued = cards
    .filter((card) => !card.history && card.status === 'Waiting for Denis' && card.sha)
    .map((card) => ({
      lane: card.lane,
      title: card.title,
      sha: card.sha as string,
      version: card.version,
      desk: card.desk,
    }));
  const next = queued.map((row) => row.version).find((version) => !!version) ?? null;
  return {
    prod: tips.prod,
    staging: tips.staging,
    next_version: next,
    queued,
  };
}
