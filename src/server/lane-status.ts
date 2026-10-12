/**
 * One "what's missing" line for a developer lane. Pure: callers pass the
 * freeze, the quick check, the full gate, and the git facts.
 *
 * Staging needs a reviewer PASS plus a green quick check or a green full run.
 * Production Promote needs a green full gate on that same SHA.
 */

export type ReviewWord = 'pass' | 'needs-fixes' | 'reject';
export type CheckState = 'green' | 'red' | 'pending' | 'missing' | 'unconfigured';

export interface GateView {
  state: 'unconfigured' | 'not_run' | 'queued' | 'running' | 'green' | 'red';
  failingStep?: string | null;
}

export interface LaneStatusInput {
  /** Lane head (or the freeze SHA when that is all we have). */
  sha: string;
  author?: string | null;
  reviewer?: string | null;
  freeze?: {
    sha: string;
    verdict: ReviewWord | null;
    /** Code findings. Zero means an evidence hold when the verdict is needs-fixes. */
    issues: number;
    gate: 'GREEN' | 'RED' | null;
  } | null;
  gate: GateView;
  /** Quick check on the freeze SHA. Omit to derive it from `gate`. */
  quick?: CheckState;
  /** Full gate (`kind=gate` or a configured full suite) on the freeze SHA. */
  full?: CheckState;
  /** Text after "Full run: " once the lane is on staging without a green full gate. */
  fullRunLabel?: string | null;
  /** Commits on main that this SHA does not contain. */
  behindMain: number;
  /** SHA does not contain what is on staging now. Ignored while behind main. */
  behindStaging?: boolean;
  /** Same refusal evaluateForward returns. Disables Stage. Ignored while behind main. */
  forwardBlock?: string | null;
  /** The deploy box could not be asked for its staging tip. Stage stays enabled. */
  stagingTipUnknown?: boolean;
  /** First failing operational prereq, shown but not a Stage lock. */
  prereqNote?: string | null;
  /** First configured protected path the diff touches. */
  protectedPath?: string | null;
  hasMigration?: boolean;
  overlap?: { lane: string; files: number } | null;
  onStaging?: boolean;
  /** What the hands-free pipeline last did for this lane. */
  autoNote?: string | null;
}

export function behindMainLine(_n: number): string {
  return 'behind main: merge main';
}

export const BEHIND_STAGING_LINE = 'behind staging — merge main';

export const READY_FOR_STAGING_BRIEF = [
  'Ready for staging:',
  '1. Merge latest origin/main.',
  '2. Quick check green on that exact SHA.',
  '3. Freeze note.',
  '4. Reviewer PASS.',
  "That's all.",
].join(' ');

export function needsGreenQuick(sha8: string): string {
  return `needs green quick check on ${sha8}`;
}

export function needsGreenFull(sha8: string): string {
  return `needs green full gate on ${sha8}`;
}

export function promoteBlockReason(sha8: string): string {
  return `full run not green on ${sha8}`;
}

export function onStagingQuickLine(label: string): string {
  return `On staging (quick check) · Full run: ${label}`;
}

export function fullFailFlag(step: string | null | undefined): string {
  return `Full run FAILED after staging: ${step || 'failed'}. Fix before asking for prod`;
}

export const QUICK_CHECK_RUNNING = 'quick check running';

function at(name: string | null | undefined, fallback: string): string {
  const n = (name ?? '').trim().replace(/^@/, '');
  return `@${n || fallback}`;
}

function resolved(input: LaneStatusInput): { quick: CheckState; full: CheckState } {
  if (input.quick !== undefined || input.full !== undefined) {
    return { quick: input.quick ?? 'missing', full: input.full ?? 'missing' };
  }
  const g = input.gate.state;
  if (g === 'unconfigured') return { quick: 'unconfigured', full: 'unconfigured' };
  if (g === 'green') return { quick: 'green', full: 'green' };
  if (g === 'red') return { quick: 'red', full: 'red' };
  if (g === 'queued' || g === 'running') return { quick: 'pending', full: 'pending' };
  return { quick: 'missing', full: 'missing' };
}

function processStep(input: LaneStatusInput): string | null {
  const head = (input.sha || '').slice(0, 8);
  const author = at(input.author, 'author');
  const reviewer = at(input.reviewer, 'reviewer');
  const freeze = input.freeze;
  if (!freeze) return `needs author freeze on ${head} — ${author}`;
  const sha8 = freeze.sha.slice(0, 8);
  const { quick, full } = resolved(input);
  const fullGreen = full === 'green';
  const stageGreen = quick === 'green' || fullGreen;
  const evidenceHold = freeze.verdict === 'needs-fixes' && freeze.issues === 0 && fullGreen;
  if (evidenceHold) return `reviewer holding for gate — GREEN landed, pinged ${reviewer}`;
  if (freeze.verdict !== 'pass') return 'waiting for PASS';
  const testsKnown = quick !== 'unconfigured' || full !== 'unconfigured';
  if (!stageGreen && testsKnown) {
    if (quick === 'red' || full === 'red') return 'tests red';
    if (quick === 'pending') return QUICK_CHECK_RUNNING;
    return needsGreenQuick(sha8);
  }
  if (input.onStaging && !fullGreen && full !== 'unconfigured') {
    return onStagingQuickLine(input.fullRunLabel || 'not run');
  }
  return null;
}

/** The single visible line. Behind-main wins on its own: the lane cannot move until it is merged up. */
export function laneStatusLine(input: LaneStatusInput): string {
  if (input.behindMain > 0) return behindMainLine(input.behindMain);
  if (input.forwardBlock) return input.forwardBlock;
  if (input.behindStaging) return BEHIND_STAGING_LINE;
  const notes: string[] = [];
  if (input.stagingTipUnknown) notes.push('staging tip unknown');
  if (input.protectedPath) notes.push(`touches ${input.protectedPath} — dev lanes must not`);
  if (input.hasMigration) notes.push('has migration — deploy agent stages it');
  if (input.overlap && input.overlap.files > 0) {
    const n = input.overlap.files;
    notes.push(`overlaps lane ${input.overlap.lane} in ${n} file${n === 1 ? '' : 's'}`);
  }
  const step = processStep(input);
  if (step) notes.push(step);
  else if (input.autoNote) notes.push(input.autoNote);
  if (input.autoNote && step) notes.push(input.autoNote);
  if (input.prereqNote) notes.push(input.prereqNote);
  if (notes.length === 0) return input.onStaging ? 'on staging — mark Ready for prod' : 'ready for staging';
  return notes.join(' · ');
}

export const DEFAULT_BEFORE_FREEZE_TIP =
  'Run the quick check during development, and run the full suite only after the lane is on staging.';
