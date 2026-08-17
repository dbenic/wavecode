# WaveCode Operating Model

Who does what, how work and specifications flow, how agents are checked
while they work, and who verifies the result afterwards. Everything here
describes enforced behavior in the current codebase — where something is a
convention rather than enforcement, it says so.

## 1. Roles and authority

| Role | Runs as | Does | Never does |
|---|---|---|---|
| **Human** | phone/desktop PWA, or notifications (Web Push / ntfy / Telegram) | final approvals in the review queue, override decisions (with stored reasons), emergency stop, config changes | writes feature code |
| **Orchestrator** | any MCP client (Grok, Claude, a script) via `wavecode mcp`, or the built-in Command Chat | decomposes goals into task DAGs, assigns tasks, watches output, requests reviews, recommends promote/reject | approves gated work without a pass verdict (the API blocks it the same as the UI) |
| **Developer agents** | one tmux session each (claude-code / codex / aider / any configured runtime), spawned or adopted | execute exactly the tasks dispatched to them, fix issues their reviewer found | review their own work in the auto loop (the reviewer resolver never picks the author), merge/approve anything |
| **Reviewer agents** | same pool — any agent other than the author (config `review.default_reviewer` by name or runtime), falling back to the WaveCode LLM | review diffs, deliver a structured verdict (`PASS` / `NEEDS FIXES` / `REJECT`) | — |
| **QA agent** | `wavecode qa` (browser + vision LLM) | goal-driven UI testing, findings with evidence, reports attached to agent docs | — |

**Identity of each agent** is explicit: name, runtime, and a pinned
`model` + `effort` (e.g. `grok-4.6 @xhigh`) recorded in the database, shown
on the dashboard card, injected into the CLI launch command, and settable
over MCP (`spawn_agent`, `pin_agent`). "Which agent is doing what" is always
answerable from `list_agents` + `list_tasks`: tasks carry their assignee,
runs carry both task and agent.

## 2. How specifications are shared

Work flows to agents through exactly one door: **the task**. Everything else
is context that WaveCode attaches around it.

1. **Tasks** (`create_task`, Task Board, or goal decomposition) carry the
   prompt, priority, assignee, and DAG edges. Dependents dispatch only when
   prerequisites are `done` — and, with `review.gate_dependents_on_approval`
   on, only when the prerequisite's run was **approved**, so unreviewed work
   never becomes a foundation.
2. **Briefings** — at dispatch, WaveCode prepends an automatic context
   briefing (sibling agents, recent changes, recorded decisions) to the task
   prompt, so agents in one workspace share situational awareness.
3. **Guides** (Library) — persistent reference docs attached per agent.
4. **Artifacts** — immutable, hashed files. The operator share path is
   MCP `upload_artifact` → `share_artifact` / attach-on-upload → file
   lands in the agent's `.wavecode/artifacts` workspace (`attached_path`).
   `list_artifacts?agent_id=` confirms the implementer has the file.
   Put the id/path in the `create_task` prompt. Not a chat bridge.
5. **Messages** (the wire) — persistent addressed/broadcast messages with
   task/run references (`send_message` / `list_messages`, mirrored on SSE).
6. **Specs** (Research) — research runs produce markdown specs that can be
   targeted at an agent.

## 3. How agents are checked while working (periodic checks)

All checks are periodic and automatic; none rely on the agent's honesty:

| Check | Interval | Mechanism | On failure |
|---|---|---|---|
| Output watch | 2 s | `tmux capture-pane` diff + status regex per runtime | status flips on the dashboard in real time (SSE) |
| Runner heartbeat | 30 s | ndjson events from spawned runners over Unix socket | run marked failed on exit codes |
| Session liveness | 30 s | `tmux has-session` | spawned + `auto_restart`: session recreated, running tasks re-queued; adopted: `agent.crashed` + push/ntfy/Telegram notification |
| Hang detection | 30 s | pane content hash unchanged for `hang_timeout_min` while `working` | spawned: session killed → auto-restart cycle; adopted: `agent.hung` event |
| Completion verification | on idle | `verify_completion`: a cheap LLM judges the last 30 terminal lines against the task | `failed` verdicts re-queue the task (bounded by `max_task_retries`) |

A run's self-reported "success" is never the end of the story — it only
moves the work into the review pipeline below.

**Orchestrate signal (not promote):** every run has an append-only local
result file (`{workspace}/.wavecode/runs/<runId>/result.txt`). Last line
must be exactly `RESULT: PASS` or `RESULT: FAIL`, with a one-line reason
above it. Orchestrate reads that file only — never tmux/pane scrape. API
fields are a convenience; the file is the source of truth. Idle, a
collapsed TUI ("reviewed by another AI"), short duration, or pane scrape
is never PASS. If the agent did not write a valid RESULT, WaveCode may
append `RESULT: FAIL` or leave the file missing. Referee / wavepulse-gate
RESULT remains the only promote evidence.

## 4. Who tests the work afterwards

The review pipeline, in order:

1. **Automatic cross-review** (`review.auto_review: true`): every finished
   run's git diff is reviewed by a *different* agent — the resolver picks
   `default_reviewer` by name, then by runtime, and explicitly refuses the
   author; with no other agent available, the WaveCode LLM reviews directly.
   The reviewer answers in a fixed format; the parsed **verdict** and issue
   count are stored on the review row (an unparseable review is treated as
   `needs-fixes`, never as a pass). An empty or uncapturable diff still
   inserts a completed `code_reviews` row with `needs-fixes` so
   `/api/reviews` `latestReview` is never null after auto-review. LLM
   failures and reviewer poll timeouts finalize the same way — they do
   not leave `status='failed'` with a null verdict.
2. **Bounded fix loop**: a non-pass verdict pushes the feedback back into
   the author's terminal ("fix these, run the tests"). When the author goes
   idle again, the next review round starts automatically — up to
   `review.max_fix_loops` rounds, then the run stops looping and waits for
   a human with its full review history attached.
3. **QA agent** (optional, UI work): browser-driven, persona-based testing
   with a vision LLM; findings require evidence and are attached as reports.
4. **Human review queue** — the only place work gets *approved*. The card
   shows the latest verdict inline. **Promote is blocked** unless the
   verdict is `pass`; overriding requires an explicit reason which is stored
   in the audit event log (`review.promoted` → `override_reason`). Retry,
   hand-off (to another agent), and reject are always available.
5. **Downstream gating** (`review.gate_dependents_on_approval: true`):
   dependent tasks dispatch on *approval*, not completion — approval is the
   event that unblocks the DAG.

## 5. Safety controls

- **Per-agent kill**: KILL button in the agent view / `kill_agent` over MCP —
  terminates the tmux session and removes the agent.
- **Emergency stop-all**: STOP ALL on the dashboard / `stop_all` over MCP —
  kills every spawned agent, sends Ctrl+C to adopted ones, and disables
  auto-dispatch until a human re-enables it in Settings.
- **Pins are validated**: model/effort values are allowlisted before they
  ever reach a shell.
- **Audit trail**: every state change (dispatch, run, review, verdict,
  override, kill, stop-all) is an immutable row in `events`, streamed live
  over SSE and queryable after the fact.

## 6. Configuration quick reference

```yaml
review:
  auto_review: true              # cross-review every finished run
  default_reviewer: reviewer-bot # agent name or runtime; never the author
  max_fix_loops: 2               # bounded fix→re-review rounds
  require_pass_to_promote: true  # promote gate even without auto_review
  gate_dependents_on_approval: true  # DAG advances on approval, not 'done'
autonomy:
  verify_completion: true        # LLM sanity-check on task completion
  hang_timeout_min: 10
  max_task_retries: 2
```

## 7. Known limits (deliberate, current)

- Verdict capture from *agent* reviewers scrapes the reviewer's terminal for
  up to 2 minutes; slow reviewers should be given LLM-direct review instead.
- Branch-level enforcement (per-agent push allowlists via git hooks/keys) is
  deployment-level work, not yet enforced by WaveCode itself.
- Budget caps (tokens/cost per agent) are not yet tracked for agent runs.
