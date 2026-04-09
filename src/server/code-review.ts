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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_code_reviews_run ON code_reviews(run_id);
  `);
}

export function getReviewsForRun(runId: string): CodeReview[] {
  return getDb().prepare(
    'SELECT * FROM code_reviews WHERE run_id = ? ORDER BY created_at DESC'
  ).all(runId) as CodeReview[];
}

export function getReview(reviewId: string): CodeReview | null {
  return getDb().prepare(
    'SELECT * FROM code_reviews WHERE id = ?'
  ).get(reviewId) as CodeReview | null;
}

// --- Diff capture ---

function captureGitDiff(tmuxSession: string): string | null {
  try {
    const paneDir = tmux.getPaneDir(tmuxSession);
    if (!paneDir) return null;

    // Try staged + unstaged diff first, fall back to unstaged only
    let diff: string;
    try {
      diff = execFileSync('git', ['-C', paneDir, 'diff', 'HEAD'], {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
    } catch {
      diff = execFileSync('git', ['-C', paneDir, 'diff'], {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
    }

    return diff || null;
  } catch {
    return null;
  }
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
  const diff = captureGitDiff(agent.tmux_session);

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
    getDb().prepare('UPDATE code_reviews SET status = ? WHERE id = ?').run('failed', reviewId);
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
): Promise<Result<CodeReview>> {
  const runResult = getRun(runId);
  if (!runResult.ok) return { ok: false, error: runResult.error };

  const run = runResult.data;
  const agentResult = getAgent(run.agent_id);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  const agent = agentResult.data;
  const config = getConfig();

  // Capture diff from the original agent
  const diff = captureGitDiff(agent.tmux_session);
  if (!diff) {
    return { ok: false, error: 'No git diff found — agent may not have made changes' };
  }

  // Also capture the agent's recent output for context
  const outputResult = sessionManager.capturePane(agent.tmux_session, 30);
  const agentOutput = outputResult.ok ? outputResult.data : '';

  // Find or use the reviewer agent
  let reviewerAgent: typeof agent | null = null;

  if (reviewerAgentId) {
    const result = getAgent(reviewerAgentId);
    if (result.ok) reviewerAgent = result.data;
  }

  // Determine the runtime to use
  const runtime = reviewerRuntime ?? config.review.default_reviewer;

  // Create review record
  const reviewId = generateId();
  getDb().prepare(`
    INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, reviewer_runtime, status, diff)
    VALUES (?, ?, 'cross-model', ?, ?, 'reviewing', ?)
  `).run(reviewId, runId, reviewerAgent?.id ?? null, runtime, diff);

  // Build the review prompt with the diff
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

  if (reviewerAgent) {
    // Send to existing agent
    const sendResult = sessionManager.sendKeys(reviewerAgent.id, reviewPrompt);
    if (!sendResult.ok) {
      getDb().prepare('UPDATE code_reviews SET status = ? WHERE id = ?').run('failed', reviewId);
      return { ok: false, error: `Failed to send to reviewer: ${sendResult.error}` };
    }

    pollForReviewCompletion(reviewId, reviewerAgent.tmux_session);
  } else {
    // No reviewer agent specified — use the WaveCode LLM (Claude API) directly
    reviewWithLLM(reviewId, reviewPrompt, runtime);
  }

  emit('review.ai_started', 'run', runId, {
    review_id: reviewId,
    type: 'cross-model',
    runtime,
    reviewer_agent: reviewerAgent?.name ?? 'llm-direct',
  });

  logger.info({ reviewId, runId, runtime, reviewer: reviewerAgent?.name ?? 'llm' }, 'Cross-model review started');

  const review = getDb().prepare('SELECT * FROM code_reviews WHERE id = ?').get(reviewId) as CodeReview;
  return { ok: true, data: review };
}

// --- LLM-direct review (no agent needed) ---

async function reviewWithLLM(reviewId: string, prompt: string, _runtime: string): Promise<void> {
  try {
    const result = await completeText({
      userMessage: prompt,
      maxTokens: 2048,
    });

    if (!result.ok) {
      getDb().prepare('UPDATE code_reviews SET status = ?, feedback = ? WHERE id = ?')
        .run('failed', result.error, reviewId);
      return;
    }

    const feedback = result.data;

    // Count issues
    const issueMatches = feedback.match(/- \[(HIGH|MED|LOW)\]/g);
    const issuesFound = issueMatches?.length ?? 0;

    getDb().prepare('UPDATE code_reviews SET status = ?, feedback = ?, issues_found = ? WHERE id = ?')
      .run('done', feedback, issuesFound, reviewId);

    emit('review.ai_completed', 'run', reviewId, {
      issues_found: issuesFound,
      verdict: feedback.includes('PASS') ? 'pass' : feedback.includes('REJECT') ? 'reject' : 'needs-fixes',
    });
  } catch (e) {
    getDb().prepare('UPDATE code_reviews SET status = ?, feedback = ? WHERE id = ?')
      .run('failed', (e as Error).message, reviewId);
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
      getDb().prepare('UPDATE code_reviews SET status = ? WHERE id = ?').run('failed', reviewId);
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
        const feedback = lines.slice(reviewStart).join('\n').trim();
        const issueMatches = feedback.match(/- \[(HIGH|MED|LOW)\]/g);
        const issuesFound = issueMatches?.length ?? 0;

        getDb().prepare('UPDATE code_reviews SET status = ?, feedback = ?, issues_found = ? WHERE id = ?')
          .run('done', feedback, issuesFound, reviewId);

        emit('review.ai_completed', 'run', reviewId, {
          issues_found: issuesFound,
        });
      } else {
        getDb().prepare('UPDATE code_reviews SET status = ?, feedback = ? WHERE id = ?')
          .run('done', output.substring(output.length - 2000), reviewId);
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

  emit('review.fixes_sent', 'run', review.run_id, {
    review_id: reviewId,
    agent: agentResult.data.name,
  });

  return { ok: true, data: undefined };
}
