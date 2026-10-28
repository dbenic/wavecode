# Plan: delivery tracker (Temporal's model, WaveCode's engine)

Written 27 Oct 2026 by the admin session for Denis. Status: PLAN. Build starts on Denis's GO, after the 27 Oct production release.

## Why not run Temporal itself

Temporal's engine is MIT and its model is exactly what we lack: a durable multi-step execution with a timeout per step, heartbeats, a retry policy and a full history. But it is a separate server with its own persistence. Its dev server can keep state in a SQLite file and is documented as "not intended for production"; production needs Postgres, MySQL or Cassandra plus the server processes. WaveCode's rule is one daemon and one SQLite file. Adding Temporal would add a second system to keep alive on countix-dev for one feature. So we borrow the model, not the server. Everything below runs inside the daemon on the existing `events` table and one new table.

## What we borrow, by name

| Temporal | Delivery tracker |
|---|---|
| Workflow Execution | one delivery: a feature from spec to production |
| Activity | one stage of the delivery (table below) |
| Schedule-To-Start timeout | stage assigned but nobody started (agent reserved, no quota, busy elsewhere) |
| Start-To-Close timeout | stage running too long (the 1 h 15 min on codex6) |
| Heartbeat timeout | no progress event for the stage within N minutes, even if "running" |
| Retry Policy | what the driver may do by itself: reassign, resubmit a gate, re-ping a reviewer; max attempts; then escalate |
| Signal | a WaveCode event that moves the stage (freeze ingested, gate.result, review.ai_completed, merge_queue.merged, release.reported) |
| Query | `GET /api/deliveries/:id` and the Command Center card |
| History | the events already written; the tracker only adds stage rows |

## Stages

| # | Stage | Starts on | Done on | Schedule-To-Start | Start-To-Close | Heartbeat |
|---|---|---|---|---|---|---|
| 1 | spec | delivery created with a spec path | task(s) created with goal_id | 30 min | 2 h | 30 min |
| 2 | build | task.dispatched / agent.prompt_sent | freeze ingested on the lane | 15 min | 3 h | 20 min (agent.output events) |
| 3 | first pass | pipeline.first_pass_requested | pipeline.first_pass | 5 min | 20 min | |
| 4 | gates | pipeline.quick / pipeline.gate submitted | gate.result GREEN for quick and api (a GREEN full counts) | 5 min | 25 min | 10 min (gateway status) |
| 5 | review | pipeline.review assign | review.ai_completed PASS | 5 min | 45 min | |
| 6 | land | merge_queue.queued | merge_queue.merged | 5 min | 30 min | |
| 7 | candidate | main frozen for release | full gate GREEN + release reviews PASS on that SHA | 10 min | 1 h | |
| 8 | release | release request sent (Promote) | release.reported deployed | 5 min | 45 min | 10 min (progress lines) |

Budgets are config (`deliveries.budgets_min.<stage>`), the numbers above are today's defaults. A stage that fails (gate RED, NEEDS FIXES, bounce) goes back to the stage that owns the fix with attempt+1; the retry policy caps attempts per stage (default 3) before escalation.

## Stall detection

One tick every minute (same loop as the merge queue). For every open delivery and its current stage:

- past Schedule-To-Start: `delivery.stalled` with cause `NOT_STARTED` and the assigned seat's state (reserved by, quota from the usage probe, current task).
- past Heartbeat: cause `NO_PROGRESS` with the last event seen.
- past Start-To-Close: cause `OVERRUN`.
- blocked by a rule: cause copied from WaveCode's own reason strings (`LANE_DENIED`, `GATE_NOT_GREEN: …`, `waits for @codex1's other run`, `freeze refused`). Nothing is skipped silently any more: the queue's `laneAutomationDenied` and the pipeline's refusals write a stage note instead of only a log line.

Each stall emits one event, one message to the responsible seat, and one to Denis's seat (pm-denis) in the queue's words. Repeats are deduped per stage per cause.

## The driver (rulebook, not a coder)

A delivery seat reads `/api/deliveries` and nothing else. Allowed actions, each an existing admin API call, each written to the delivery history:

1. `NOT_STARTED` on build with the seat reserved or above the usage threshold: reassign the task to the least-loaded seat on another login (`POST /api/tasks/:id/reassign`).
2. `NO_PROGRESS` on gates: resubmit once; a GREEN full run is accepted as quick+api; cancel the gateway run on a superseded SHA.
3. Review stalled: re-ping once, then reassign the reviewer.
4. Land stalled on `GATE_NOT_GREEN` with results present: requeue.
5. Anything else, and anything touching production: escalate to Denis with the cause. Never a GO, never a push.

pm-denis can be this seat for release deliveries; a separate `pm-delivery` seat for everything else once there is more than one delivery a day.

## Two queue rules that go with it

- A GREEN full run on a SHA counts as quick and api for the merge queue (`gate-status --require` learns `full` satisfies both).
- Release lanes (flag on the delivery) are exempt from the per-author gate serialization and go first on the gateway.

## Data

One table `deliveries` (id, goal_id, title, spec_path, lanes_json, stage, stage_started_at, stage_assigned_at, last_progress_at, attempts, status, created_at) and `delivery_stages` (delivery_id, stage, attempt, started_at, finished_at, outcome, cause, actor). Stage transitions are derived from events by lane and SHA; the first version backfills today's bank posting from the events table as the proof.

## Order and effort

Status 27 Oct 2026, 21:15 CET: steps 1 and 2 built and live on countix-dev (`src/server/deliveries.ts`, `routes/deliveries.ts`, schema v29, page `/deliveries`, `docs/api.md` "Delivery tracker"; `deliveries.notify: [pm-denis]`). Proof: the bank-posting day and the a78dda93 release candidate backfilled from the events table and corrected until they matched the day (a freeze note emits no event, the pipeline's first reaction is the signal; hand merges on GitHub land through `lane.retired`; stalls older than the record are shown, not messaged). Known gap: a release through the SystemOps path is invisible until `releases.production_command` is in use, so such a candidate is closed by hand. Steps 3 and 4 open.

1. Table, derivation from events, `/api/deliveries`, Command Center card with time-in-stage. One day.
2. Stall tick with the four causes, messages to seats. Half a day.
3. The two queue rules. Half a day.
4. Driver seat brief and the reassign/requeue endpoints it needs. One day.
5. Later: Apache DevLake for the monthly view, if wanted.

## Every task and lane gets a record (28 Oct 2026)

Why: pm-denis set up a 15-minute poll inside its own session to watch codex1's bank fix, because the lane
(`wc-codex1-bank-multi-konto`, started with a prompt, no desk number) had no delivery record and so no stall
messages. A poll in a seat's session dies with the session, costs a prompt every 15 minutes and sees only what
the seat thinks to look at. Denis: "I want tracking for each task."

How: `adoptWork` on the delivery tick (`deliveries.auto_track`, default on).
- Running tasks (not the pipeline's review/verify tasks): join the open record of the agent's current lane or of
  the task's goal, else a record titled by the prompt's first line, `task_ids` + `agent_ids` set, since = the
  task's creation.
- Lanes ahead of main, read from git: a desk-marked lane joins or opens PD-<n>; any other lane gets a record
  named after it, since = its first own commit. Only active lanes count: tip moved or frozen in the last 48 h, or an
  agent's workspace is on it (then from the moment the branch exists, before any push). The
  first sweep used 14 days and opened 106 records, mostly abandoned lanes; those were cancelled.
- A record with tasks or agents opens in `build` (someone is already working), not `spec`.
- New signals on the build span: `run.failed` of a tracked task = blocked (`run failed: …`), `run.finished`
  clears; `agent.hung` of a tracked agent = blocked (`@seat quiet for N min`), the new `agent.resumed` (health
  monitor, first output after an alert) clears. Build over its 180-minute budget is an overrun like before.
- Stalls that predate the record are shown, not messaged (unchanged), so the first sweep over existing lanes
  does not flood pm-denis.
- Seat tools: `list_deliveries` (status, desk, limit) and `create_delivery` (title/desk/project/lanes).
  Seat brief: follow work from the tracker, never a poll in the session.

