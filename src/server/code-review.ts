import { execFileSync } from 'node:child_process';
import {
  getDb, generateId, getRun, getTask, getAgent, listAgents,
  type Run, type Result,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import { completeText } from './llm-provider.js';
import * as sessionManager from './session-manager.js';
import * as tmux from './tmux.js';
import logger from './logger.js';

// --- DB: code_reviews table ---

export type ReviewVerdict = 'pass' | 'needs-fixes' | 'reject';

export interface CodeReview {
  id: string;
  run_id: string;
  reviewer_type: 'self' | 'cross-model';
  reviewer_agent_id: string | null;
  reviewer_runtime: string | null;
  status: 'pending' | 'reviewing' | 'done' | 'failed';
  diff: string | null;
  feedback: string | null;
  issues_found: number;
  verdict: ReviewVerdict | null;
  fix_round: number;
  fixes_sent_at: string | null;
  created_at: string;
}

export function ensureReviewTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS code_reviews (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      reviewer_type TEXT NOT NULL,
      reviewer_agent_id TEXT,
      reviewer_runtime TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      diff TEXT,
      feedback TEXT,
      issues_found INTEGER DEFAULT 0,
      verdict TEXT,
      fix_round INTEGER NOT NULL DEFAULT 0,
      fixes_sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_code_reviews_run ON code_reviews(run_id);
  `);

  // Upgrade pre-existing tables in place (ALTER TABLE has no IF NOT EXISTS)
  for (const column of ['verdict TEXT', 'fix_round INTEGER NOT NULL DEFAULT 0', 'fixes_sent_at TEXT']) {
    try {
      getDb().exec(`ALTER TABLE code_reviews ADD COLUMN ${column}`);
    } catch { /* column already exists */ }
  }
}

// --- Verdict + issue parsing ---

/**
 * Parse the reviewer's verdict from its feedback text.
 *
 * Only a standalone `VERDICT: <value>` line counts — the prompt template
 * line (`VERDICT: [PASS / NEEDS FIXES / REJECT]`) lists all three options
 * and must never match, which is why the pattern anchors to end-of-line.
 * The LAST match wins so an echoed prompt above the real answer is ignored.
 * Falls back to the self-review "REVIEW PASS:" marker; anything else is
 * treated as needs-fixes — an unparseable review must never count as a pass.
 */
export function parseVerdict(feedback: string): ReviewVerdict {
  const matches = [...feedback.matchAll(/^\s*VERDICT:\s*\[?\s*(PASS|NEEDS[ _-]?FIXES|REJECT)\s*\]?\s*$/gim)];
  const last = matches[matches.length - 1]?.[1]?.toUpperCase();
  if (last === 'PASS') return 'pass';
  if (last === 'REJECT') return 'reject';
  if (last) return 'needs-fixes';

  if (/REVIEW PASS:/i.test(feedback)) return 'pass';
  return 'needs-fixes';
}

/**
 * Count issue bullets. Accepts both the exact prompt format
 * `- [severity: HIGH]` and the shorthand `- [HIGH]`.
 */
export function countIssues(feedback: string): number {
  return [...feedback.matchAll(/^\s*- \[(?:severity:\s*)?(HIGH|MED|LOW)\b/gim)].length;
}

export function getReviewsForRun(runId: string): CodeReview[] {
  return getDb().prepare(
    'SELECT * FROM code_reviews WHERE run_id = ? ORDER BY created_at DESC, id DESC'
  ).all(runId) as CodeReview[];
}

/**
 * The most recent completed (status='done') review for a run, or null.
 * This is what promote-gating consults.
 */
export function getLatestCompletedReview(runId: string): CodeReview | null {
  return (getDb().prepare(
    `SELECT * FROM code_reviews WHERE run_id = ? AND status = 'done'
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get(runId) as CodeReview | undefined) ?? null;
}

export function getReview(reviewId: string): CodeReview | null {
  return getDb().prepare(
    'SELECT * FROM code_reviews WHERE id = ?'
  ).get(reviewId) as CodeReview | null;
}

// --- Diff capture ---

function gitOutput(dir: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function formatChangedFiles(changedFiles: string | null | undefined): string | null {
  if (!changedFiles) return null;
  try {
    const files = JSON.parse(changedFiles) as unknown;
    if (!Array.isArray(files) || files.length === 0) return null;
    const names = files.filter((f): f is string => typeof f === 'string' && f.trim().length > 0);
    if (names.length === 0) return null;
    return `Changed files (no unified diff available):\n${names.map((f) => `- ${f}`).join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Capture a reviewable diff. Prefer the tmux pane cwd, then the agent's
 * workspace; if the working tree is clean, fall back to `git show HEAD`
 * (the agent may have committed) and finally `run.changed_files`.
 */
export function captureGitDiff(opts: {
  tmuxSession: string;
  workspace?: string | null;
  changedFiles?: string | null;
}): string | null {
  const dirs = [...new Set(
    [tmux.getPaneDir(opts.tmuxSession), opts.workspace]
      .filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0),
  )];

  for (const dir of dirs) {
    const working = gitOutput(dir, ['diff', 'HEAD']) ?? gitOutput(dir, ['diff']);
    if (working) return working;
  }

  for (const dir of dirs) {
    const committed = gitOutput(dir, ['show', 'HEAD', '--format=', '--']);
    if (committed) return committed;
  }

  return formatChangedFiles(opts.changedFiles);
}

// --- Self-Review ---

export async function requestSelfReview(runId: string): Promise<Result<CodeReview>> {
  const runResult = getRun(runId);
  if (!runResult.ok) return { ok: false, error: runResult.error };

  const run = runResult.data;
  const agentResult = getAgent(run.agent_id);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const agent = agentResult.data;

  // Capture diff
  const diff = captureGitDiff({
    tmuxSession: agent.tmux_session,
    workspace: agent.workspace,
    changedFiles: run.changed_files,
  });

  // Create review record
  const reviewId = generateId();
  getDb().prepare(`
    INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, reviewer_runtime, status, diff)
    VALUES (?, ?, 'self', ?, ?, 'reviewing', ?)
  `).run(reviewId, runId, agent.id, agent.runtime, diff);

  // Send self-review prompt to the agent
  const reviewPrompt = `Review your recent changes critically before they are promoted. Check for:
1. Bugs or logic errors
2. Missing error handling or edge cases
3. Security vulnerabilities
4. Missing tests for new functionality
5. Code quality and naming

If you find issues, fix them now. If everything looks good, say "REVIEW PASS: no issues found."
Start your review with "REVIEW:" so I can capture the results.`;

  const sendResult = sessionManager.sendKeys(agent.id, reviewPrompt);
  if (!sendResult.ok) {
    finalizeReview(reviewId, systemReviewFeedback(`failed to send review prompt: ${sendResult.error}`), {
      allowFixLoop: false,
    });
    return { ok: false, error: sendResult.error };
  }

  emit('review.ai_started', 'run', runId, {
    review_id: reviewId,
    type: 'self',
    agent: agent.name,
  });

  logger.info({ reviewId, runId, agent: agent.name }, 'Self-review started');

  // Poll for review completion (check every 5s for up to 2 min)
  pollForReviewCompletion(reviewId, agent.tmux_session);

  const review = getDb().prepare('SELECT * FROM code_reviews WHERE id = ?').get(reviewId) as CodeReview;
  return { ok: true, data: review };
}

// --- Cross-Model Review ---

export async function requestCrossModelReview(
  runId: string,
  reviewerAgentId?: string,
  reviewerRuntime?: string,
  fixRound: number = 0,
): Promise<Result<CodeReview>> {
  const runResult = getRun(runId);
  if (!runResult.ok) return { ok: false, error: runResult.error };

  const run = runResult.data;
  const agentResult = getAgent(run.agent_id);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const agent = agentResult.data;
  const config = getConfig();

  // Find or use the reviewer agent before INSERT so the row records it
  let reviewerAgent: typeof agent | null = null;

  if (reviewerAgentId) {
    const result = getAgent(reviewerAgentId);
    if (result.ok) reviewerAgent = result.data;
  }

  const runtime = reviewerRuntime ?? config.review.default_reviewer;
  const diff = captureGitDiff({
    tmuxSession: agent.tmux_session,
    workspace: agent.workspace,
    changedFiles: run.changed_files,
  });

  const reviewId = generateId();
  getDb().prepare(`
    INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, reviewer_runtime, status, diff, fix_round)
    VALUES (?, ?, 'cross-model', ?, ?, 'reviewing', ?, ?)
  `).run(reviewId, runId, reviewerAgent?.id ?? null, runtime, diff, fixRound);

  if (!diff) {
    finalizeReview(reviewId, systemReviewFeedback('no diff available to review'), { allowFixLoop: false });
    const review = getReview(reviewId);
    return review
      ? { ok: true, data: review }
      : { ok: false, error: 'Review row missing after empty-diff finalize' };
  }

  const outputResult = sessionManager.capturePane(agent.tmux_session, 30);
  const agentOutput = outputResult.ok ? outputResult.data : '';

  const taskResult = getTask(run.task_id);
  const taskPrompt = taskResult.ok ? taskResult.data.prompt : 'unknown task';

  const reviewPrompt = `You are reviewing code changes made by another AI agent. Be thorough and critical.

TASK: ${taskPrompt}

AGENT OUTPUT SUMMARY:
${agentOutput.replace(/[^\x20-\x7E\n\r\t]/g, ' ').substring(0, 1000)}

GIT DIFF:
\`\`\`diff
${diff.substring(0, 8000)}
\`\`\`

Review this diff for:
1. BUGS: Logic errors, off-by-one, null pointer, race conditions
2. SECURITY: Injection, auth bypass, data exposure, hardcoded secrets
3. QUALITY: Naming, duplication, complexity, missing abstractions
4. TESTS: Missing test coverage for new/changed code
5. EDGE CASES: Error handling, boundary conditions, empty inputs

Format your response as:
REVIEW SUMMARY: [one line overall assessment]
ISSUES:
- [severity: HIGH/MED/LOW] [description]
- ...
VERDICT: [PASS / NEEDS FIXES / REJECT]`;

  emit('review.ai_started', 'run', runId, {
    review_id: reviewId,
    type: 'cross-model',
    runtime,
    reviewer_agent: reviewerAgent?.name ?? 'llm-direct',
  });
  logger.info({ reviewId, runId, runtime, reviewer: reviewerAgent?.name ?? 'llm' }, 'Cross-model review started');

  if (reviewerAgent) {
    const sendResult = sessionManager.sendKeys(reviewerAgent.id, reviewPrompt);
    if (!sendResult.ok) {
      finalizeReview(reviewId, systemReviewFeedback(`failed to send review prompt: ${sendResult.error}`), {
        allowFixLoop: false,
      });
      return { ok: false, error: `Failed to send to reviewer: ${sendResult.error}` };
    }

    pollForReviewCompletion(reviewId, reviewerAgent.tmux_session);
  } else {
    await reviewWithLLM(reviewId, reviewPrompt, runtime);
  }

  const review = getDb().prepare('SELECT * FROM code_reviews WHERE id = ?').get(reviewId) as CodeReview;
  return { ok: true, data: review };
}

// --- LLM-direct review (no agent needed) ---

function systemReviewFeedback(reason: string): string {
  return [
    `REVIEW SUMMARY: ${reason}`,
    'ISSUES:',
    `- [severity: MED] ${reason}`,
    'VERDICT: NEEDS FIXES',
  ].join('\n');
}

async function reviewWithLLM(reviewId: string, prompt: string, _runtime: string): Promise<void> {
  try {
    const result = await completeText({
      userMessage: prompt,
      maxTokens: 2048,
    });

    if (!result.ok) {
      finalizeReview(reviewId, systemReviewFeedback(`LLM review failed: ${result.error}`), {
        allowFixLoop: false,
      });
      return;
    }

    finalizeReview(reviewId, result.data);
  } catch (e) {
    finalizeReview(reviewId, systemReviewFeedback(`LLM review failed: ${(e as Error).message}`), {
      allowFixLoop: false,
    });
  }
}

/**
 * Persist a completed review's feedback, verdict, and issue count, emit the
 * completion event, and continue the automatic fix loop when configured.
 * Shared by the LLM-direct path and the tmux polling path.
 */
export function finalizeReview(
  reviewId: string,
  feedback: string,
  opts: { allowFixLoop?: boolean } = {},
): void {
  const verdict = parseVerdict(feedback);
  const issuesFound = countIssues(feedback);

  getDb().prepare('UPDATE code_reviews SET status = ?, feedback = ?, issues_found = ?, verdict = ? WHERE id = ?')
    .run('done', feedback, issuesFound, verdict, reviewId);

  const review = getReview(reviewId);
  if (!review) return;

  emit('review.ai_completed', 'run', review.run_id, {
    review_id: reviewId,
    issues_found: issuesFound,
    verdict,
    fix_round: review.fix_round,
  });

  logger.info(
    { reviewId, runId: review.run_id, verdict, issuesFound, fixRound: review.fix_round },
    'Code review completed',
  );

  if (opts.allowFixLoop !== false) {
    maybeContinueFixLoop(review, verdict);
  }
}

// --- Automatic review loop ---

/**
 * Entry point wired into run completion: when review.auto_review is on,
 * every successful run gets a cross-model review. The author never reviews
 * its own work — if the configured default reviewer is the author (or does
 * not resolve to an agent), the review goes to the WaveCode LLM directly.
 */
export async function maybeAutoReview(runId: string): Promise<void> {
  const config = getConfig();
  if (!config.review.auto_review) return;

  const runResult = getRun(runId);
  if (!runResult.ok || runResult.data.status !== 'done') return;

  // Don't re-review a run that already has a completed or in-flight review;
  // fix-loop rounds are triggered from onAuthorAgentIdle instead.
  const existing = getReviewsForRun(runId);
  if (existing.some((r) => r.status === 'reviewing' || r.status === 'done')) return;

  const reviewerAgentId = resolveReviewerAgentId(runResult.data.agent_id);
  const result = await requestCrossModelReview(runId, reviewerAgentId ?? undefined);
  if (!result.ok) {
    logger.warn({ runId, error: result.error }, 'Auto-review could not start');
  }
}

/**
 * Resolve the reviewer for an author agent: the configured default_reviewer
 * if it names a registered agent other than the author, else any other
 * agent whose runtime matches default_reviewer, else null (LLM-direct).
 * Exported for tests.
 */
export function resolveReviewerAgentId(authorAgentId: string): string | null {
  const config = getConfig();
  const wanted = config.review.default_reviewer;
  const agents = listAgents();

  const byName = agents.find((a) => a.name === wanted && a.id !== authorAgentId);
  if (byName) return byName.id;

  const byRuntime = agents.find((a) => a.runtime === wanted && a.id !== authorAgentId);
  if (byRuntime) return byRuntime.id;

  return null;
}

/**
 * If the verdict demands fixes and the loop budget allows another round,
 * push the feedback back to the author. The next round's review is
 * triggered by onAuthorAgentIdle once the author finishes fixing.
 */
function maybeContinueFixLoop(review: CodeReview, verdict: ReviewVerdict): void {
  const config = getConfig();
  if (!config.review.auto_review) return;
  if (verdict === 'pass') return;
  if (review.reviewer_type === 'self') return;

  if (review.fix_round >= config.review.max_fix_loops) {
    logger.warn(
      { reviewId: review.id, runId: review.run_id, fixRound: review.fix_round },
      'Fix loop budget exhausted — leaving run for human review',
    );
    return;
  }

  const result = sendFixesToAgent(review.id);
  if (!result.ok) {
    logger.warn({ reviewId: review.id, error: result.error }, 'Auto fix-loop could not send fixes');
  }
}

/**
 * Called by the output watcher when an agent goes working -> idle.
 * If the agent just finished a fix round (last review has fixes_sent_at
 * and no newer review), start the next review round.
 */
export async function onAuthorAgentIdle(agentId: string): Promise<void> {
  const config = getConfig();
  if (!config.review.auto_review) return;

  const pending = getDb().prepare(`
    SELECT cr.* FROM code_reviews cr
    JOIN runs r ON r.id = cr.run_id
    WHERE r.agent_id = ?
      AND cr.status = 'done'
      AND cr.fixes_sent_at IS NOT NULL
      AND cr.fix_round < ?
      AND NOT EXISTS (
        SELECT 1 FROM code_reviews newer
        WHERE newer.run_id = cr.run_id AND newer.created_at > cr.created_at
      )
    ORDER BY cr.created_at DESC LIMIT 1
  `).get(agentId, config.review.max_fix_loops) as CodeReview | undefined;

  if (!pending) return;

  const runResult = getRun(pending.run_id);
  if (!runResult.ok || runResult.data.review_status !== 'pending') return;

  const reviewerAgentId = resolveReviewerAgentId(agentId);
  const result = await requestCrossModelReview(
    pending.run_id,
    reviewerAgentId ?? undefined,
    undefined,
    pending.fix_round + 1,
  );
  if (!result.ok) {
    logger.warn({ runId: pending.run_id, error: result.error }, 'Re-review after fixes could not start');
  }
}

// --- Poll agent terminal for review output ---

function pollForReviewCompletion(reviewId: string, tmuxSession: string): void {
  let attempts = 0;
  const maxAttempts = 24; // 24 * 5s = 2 minutes

  const timer = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(timer);
      finalizeReview(reviewId, systemReviewFeedback('reviewer poll timed out after 2 minutes'), {
        allowFixLoop: false,
      });
      return;
    }

    const captureResult = sessionManager.capturePane(tmuxSession, 50);
    if (!captureResult.ok) return;

    const output = captureResult.data;

    // Look for review markers in the output
    if (output.includes('REVIEW SUMMARY:') || output.includes('REVIEW PASS:') || output.includes('VERDICT:')) {
      clearInterval(timer);

      // Extract the review text
      const lines = output.split('\n');
      const reviewStart = lines.findIndex((l) =>
        l.includes('REVIEW SUMMARY:') || l.includes('REVIEW PASS:') || l.includes('REVIEW:')
      );

      if (reviewStart >= 0) {
        finalizeReview(reviewId, lines.slice(reviewStart).join('\n').trim());
      } else {
        // No recognizable review block — keep the tail for the human, and
        // let finalizeReview apply the safe non-pass verdict default.
        finalizeReview(reviewId, output.substring(output.length - 2000));
      }
    }
  }, 5000);
}

// --- Send fixes back to original agent ---

export function sendFixesToAgent(reviewId: string): Result<void> {
  const review = getReview(reviewId);
  if (!review) return { ok: false, error: 'Review not found' };
  if (!review.feedback) return { ok: false, error: 'No feedback to send' };

  const runResult = getRun(review.run_id);
  if (!runResult.ok) return runResult;

  const agentResult = getAgent(runResult.data.agent_id);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const fixPrompt = `Your code was reviewed by another AI model. Here are the issues found. Please fix them:

${review.feedback}

Fix all HIGH and MED severity issues. For LOW severity, fix if quick, otherwise note them.
After fixing, run the relevant tests to verify your fixes work.`;

  const sendResult = sessionManager.sendKeys(agentResult.data.id, fixPrompt);
  if (!sendResult.ok) return sendResult;

  getDb().prepare(`UPDATE code_reviews SET fixes_sent_at = datetime('now') WHERE id = ?`).run(reviewId);

  emit('review.fixes_sent', 'run', review.run_id, {
    review_id: reviewId,
    agent: agentResult.data.name,
    fix_round: review.fix_round,
  });

  return { ok: true, data: undefined };
}
