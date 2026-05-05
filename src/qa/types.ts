/**
 * Shared types for the WaveCode QA agent.
 *
 * The QA agent drives a real browser (Playwright) under guidance of a vision-
 * capable LLM (Claude). It tests features the way a human user would —
 * registering, clicking through, getting confused, asking why — and produces
 * a structured report.
 */

export type Severity = 'bug' | 'ux_issue' | 'question' | 'suggestion';

export type Outcome = 'completed' | 'abandoned' | 'blocked' | 'max_steps_reached';

/**
 * A single observation the QA agent made during a session.
 *
 * Findings are the primary deliverable. Every finding must cite evidence
 * (a quote of on-screen text or a screenshot reference) so a human can
 * verify it without re-running the session.
 */
export interface Finding {
  severity: Severity;
  summary: string;
  evidence: string;
  why_it_matters: string;
  suggested_fix?: string;
  step: number;
  screenshot_ref?: string;
}

/**
 * A persona that the QA agent inhabits during a session. The persona
 * shapes pacing, expectations, and what counts as friction.
 */
export interface Persona {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

/**
 * A scenario describes the user-facing task the QA agent should attempt.
 * Scenarios are intentionally goal-shaped, not script-shaped — the agent
 * decides the steps. That's where the value comes from vs. scripted E2E.
 */
export interface Scenario {
  id: string;
  title: string;
  goal: string;
  starting_url: string;
  acceptance_criteria?: string[];
  max_steps?: number;
}

/**
 * The full result of a QA session. Persisted to disk and (later) registered
 * as a WaveCode artifact so it shows up in the existing artifact browser.
 */
export interface RunResult {
  scenario_id: string;
  persona_id: string;
  starting_url: string;
  outcome: Outcome;
  findings: Finding[];
  step_count: number;
  duration_seconds: number;
  notes?: string;
  session_dir: string;
}
