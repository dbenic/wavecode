# Maestro contract: what WaveCode does on a freeze, and how to read it

Who this is for: the coordinating bot (maestro), SystemOps, and anyone reading
`/home/wave/inbox` or the event stream over ssh. It describes the hands-free
lane pipeline for `wavepulse` on countix-dev as configured on 25 Oct 2026.

## Two sentences for the bot

WaveCode now assigns the reviewer, pings the reviewer's pane, re-pings on GREEN,
moves a stuck review after ten minutes, submits the API gate at freeze time and asks a
spare seat for a first pass; maestro does not need to pick or ping reviewers any more.
Maestro keeps priorities, lane scoping, cross-lane decisions and escalation, reads the
files and events listed below, and overrides a reviewer only through the
`request-review` endpoint or a `<you>-to-<seat>-…md` file, never by pinging a second seat.

## Division of work

| WaveCode (daemon) | Maestro | Agents |
|---|---|---|
| Checks the freeze SHA is on the remote lane; holds the freeze until it is | Decides what is built next and in which lane | Push their own lane before freezing |
| Submits the API gate in a clean detached checkout of the exact SHA, as the author | Watches the gate result and the step times | Write the freeze note (10 lines) |
| Picks the least-loaded eligible reviewer with plan capacity and pings the pane | Escalates when a step is over its time | Review when pinged, one pass, fixed verdict line |
| Asks a spare seat for a first pass and hands the result to reviewer and author | Reads first passes as a signal, not a verdict | Fix what the first pass found while the reviewer reads |
| Re-pings on GREEN, reassigns after `review_reassign_minutes` on a busy seat | | |

WaveCode never pushes a lane, never stages, never gives a prod GO and never turns a first
pass into a verdict. Since 25 Oct 2026 it does merge eligible lanes into **Wavepulse main**
through the merge queue (`docs/merge-queue.md`), and since 26 Oct 2026 by evidence rather
than by name: any branch off the deny list queues when the exact-SHA gate is green, one
reviewer who is not the author and sits on another credential profile said PASS on that
SHA, the lane tip is unchanged and migrations are numbered after main. Ask tier adds
Denis's `ask-tier-approved` label on the pull request; a `migration-hold` label parks any
lane. A lane behind main is merged with main first and the result gated. One lane at a
time, `--no-ff`, the full suite once on the merge result, plain push, bounce on conflict
or RED. Every refusal is one code plus the missing evidence (`NO_PASS_ON_SHA`,
`GATE_NOT_GREEN`, `ASK_TIER_NO_OK`, `MIGRATION_HOLD`, `GH_AUTH_MISSING`, …). When the
GitHub credential is missing or an eligible lane waits more than 30 minutes with no
merge, `wavecode-queue-stall-<ts>.md` lands in the inbox for maestro. Staging stays with
SystemOps; the prod GO is Denis's exact-SHA message in SystemOps' chat.

An author asks for its own review when the work is done: `<you>-<lane>-review-request-<sha8>.md`
in the inbox (`Lane:`, the exact SHA, optional `Reviewer: @seat`). WaveCode picks the seat
and pings it; the author's pane is told.

## Files in `/home/wave/inbox`

| Kind | Name | Rules |
|---|---|---|
| Freeze note | `<author>-<topic>-freeze-<sha8>-<date>.md` (any name containing `freeze`) | One exact 40-character SHA, `Lane:`, `Author:`, `Project: wavepulse`, ten lines or fewer. The SHA must already be pushed. |
| Verdict | `<reviewer>-verdict-<author or lane>-<sha8>-<date>.md` (any name containing `verdict`) | Names the exact SHA. The last `VERDICT:` line decides: `VERDICT: PASS`, `VERDICT: PASS (gate pending)`, `VERDICT: NEEDS FIXES`, `VERDICT: REJECT`. A line naming two outcomes is a request, not a verdict. Reviewer must not be the author. |
| Review request | `<you>-<lane>-review-request-<sha8>.md` (any name containing `review-request`) | The author asks for its own review once the freeze note exists: `Lane:`, the exact SHA, optional `Reviewer: `. WaveCode picks the seat (or checks the named one), pings it and tells the author. Not replayed by the restart backfill. |
| First pass | `wave-firstpass-<sha8>-<yyyymmdd>.md` | Written by the seat WaveCode asked. Ends with `FIRST PASS: PASS` or `FIRST PASS: NEEDS FIXES`; issues as `- [HIGH|MED|LOW] path:line — why`. Never contains the word VERDICT, never counts as one. |
| Hand-off | `<author>-to-<recipient>-<topic>-<date>.md`, or any `.md` with a `To: @seat` line | Announced into the recipient's pane. Everything else in this folder (logs, receipts, JSON, freeze and verdict files) is not announced. |

## What happens when a freeze lands

1. **Push check.** `git fetch origin <lane>`, then the SHA must be an ancestor of
   `origin/<lane>`. If not: note `auto: freeze refused — …`, event `pipeline.refused`,
   one line to the author, and a re-check every two minutes for twelve hours. Nothing
   else happens until the SHA is on the remote.
2. **Gate.** With `auto_gate` on, the freeze shows `QUEUED` at once (event `pipeline.gate`,
   payload `gate: QUEUED`). The gate command runs in `<repos>/.wavecode-gates/wavepulse-<sha9>`,
   a detached worktree of the exact SHA, with `COUNTIX_REMOTE_TEST_WHO=<author>` and
   `WAVECODE_SHA`, `WAVECODE_LANE`, `WAVECODE_CHECKOUT` set. When the command returns, the
   exit code decides (`0` GREEN, `1` RED, `7` dispatcher duplicate stays QUEUED) and a second
   `pipeline.gate` event carries the word. The checkout is removed. The tests history
   (`countix-remote-test history --json --sha`) remains the authoritative view on the cards.
3. **First pass.** With `review.first_pass.enabled`, the least-loaded listed seat with
   plan capacity, never the author or a seat of the same person, gets one prompt and the
   target file name. Event `pipeline.first_pass_requested`. When the file lands:
   `pipeline.first_pass`, one line to the assigned reviewer, and on NEEDS FIXES one line to
   the author. No file after `timeout_min`: `pipeline.first_pass_timeout` and a note.
4. **Reviewer.** With `auto_review` on: the prefer tier for the author's vendor first
   (`reviewer_prefer`), then the open ladder limited to `reviewer_allow`, then a pooled
   same-person seat. Excluded always: the author, the author's other seats (except on a
   profile listed in `service_profiles`), `review_deny` and `agent_deny`, and any seat whose
   plan has less than `review.min_capacity_pct` left. Inside a tier the least loaded wins:
   idle before busy, fewer open reviews, fewer running tasks, least recently assigned. Event
   `pipeline.review` (`<sha>:assign`), the pane gets
   `[from WaveCode] Please review freeze <sha8> on <lane> by @author. Read <note>. If the
   code is OK and the gate is still running, write VERDICT: PASS (gate pending).` plus the
   first-pass sentence and a size warning when the lane changed more than `max_lane_files`.
5. **GREEN.** `pipeline.gate` with GREEN re-pings the reviewer (`<sha>:green`) when there is
   no PASS yet. RED tells the author to read the failing step and refreeze.
6. **Stuck review.** A review with no verdict on a busy seat for longer than
   `review_reassign_minutes` moves to the next eligible seat (`<sha>:reassign`), once, or
   again when the next seat is idle.

## Events to read

All events are rows in the `events` table and are streamed on `GET /api/events` (SSE,
`lastEventId` replays). Payloads are JSON.

| type | entity_id | payload |
|---|---|---|
| `pipeline.action` | `<project>:<lane>` | `{ action, sha, project, lane, note }` — the one-line pipeline notes (`push`, `gate`, `review`, `first-pass`, `size`, `merge`) |
| `pipeline.refused` | `<sha>` | `{ sha, project, lane, reason }` |
| `pipeline.frozen` | `<sha>` | `{ sha, project, lane, file }` (auto-freeze only) |
| `pipeline.gate` | `<sha>:full` | `{ sha, project, lane, gate: QUEUED|RUNNING|GREEN|RED, exit_code? }` |
| `pipeline.review` | `<sha>:assign|green|reassign` | `{ sha, reviewer_id, kind, assigned_at_ms, reassigned }` |
| `pipeline.first_pass_requested` | `<sha>` | `{ sha, project, lane, seat_id, seat, file, at_ms }` |
| `pipeline.first_pass` | `<sha>` | `{ sha, result: pass|needs-fixes, issues, file, seat }` |
| `pipeline.first_pass_timeout` | `<sha>` | `{ sha, seat, file, waited_ms }` |
| `review.gate_pinged` | `<sha>` | GREEN landed on a SHA whose verdict was NEEDS FIXES |
| `merge_queue.queued` | `<sha>` | `{ sha, project, lane, tier, pr }` — eligible, waiting for its turn |
| `merge_queue.merged` | `<sha>` | `{ sha_in, sha_out, main_before, lane, tier, pr, gate, gate_runs, verdict_files, enabled_by, author, at }` |
| `merge_queue.bounced` | `<sha>` | `{ sha, lane, tier, pr, reason, at }` — author told; a new SHA starts over |
| `merge_queue.requeued` | `<sha>` | `{ sha, lane, reason, attempts }` — main moved or the gate was busy; tried again |
| `merge_queue.switch` | `<project>` | `{ project, enabled, by }` — the kill switch |
| `merge_queue.stall` | `<project>` | `{ project, code, text, file, at }` — the queue cannot run or an eligible lane waited past `stall_minutes`; the file is in the inbox |

The queue also appends one line per merge or bounce to
`/home/wave/inbox/wavecode-merge-queue.log` (`<CET time> merged <lane> <sha8> -> main <sha8> (tier, PR, gate runs, verdicts)` /
`<CET time> bounced <lane> <sha8>: <reason>`). Tail that file instead of polling the cards.

The freeze note needs one more line for the queue: `TIER: ship | show | ask`. Booking, VAT,
payroll, payments, billing, RLS, auth and migration paths are `ask` whatever the note says.

Over ssh, read-only:

```bash
sqlite3 -readonly /home/wave/wavecode/wavecode.db "select created_at, type, entity_id, payload_json from events where type like 'pipeline.%' order by id desc limit 50"
```

## Endpoints maestro may use

- `GET /api/reviews/board` — one card per lane with status, action, owner, the six-step
  pipeline and the reviewers' queue depth and busy flag.
- `GET /api/reviews/lanes` — developer lanes ahead of main with a what's-missing line.
- `POST /api/reviews/lanes/request-review` `{ project, lane, reviewer }` — hand the freeze
  to a named seat. This is the override; it never offers the author.
- `GET /api/agents` — each seat's status and `usage` (plan left per profile).

A bearer token is required; a seat token for maestro can be issued later. Until then the
files and the database are the read path.

## Configuration this contract assumes (countix-dev, `config.yaml`)

```yaml
review:
  min_capacity_pct: 10
  first_pass:
    enabled: true
    seats: [codex2, codex3]
    dir: /home/wave/inbox
    timeout_min: 20
paths:
  inbox_watch: [~/inbox/from-fable, /home/wave/inbox]
projects:
  wavepulse:
    pipeline:
      auto_freeze: true             # 26 Oct 2026 (merge-queue brief): back on
      auto_gate: true               # 26 Oct 2026: back on, capped by gate_max_inflight; the merge queue still runs the full suite once on the merged code
      gate_max_inflight: 2
      auto_review: true
      gate_with_quick: true
      gate_command: [countix-remote-test, --suite, api]
      quick_check_command: [countix-remote-test, tier1]
      gate_timeout_min: 120
      review_reassign_minutes: 10
      max_lane_files: 40
      reviewer_prefer:
        claude: [codex4, codex5, codex7, codex8]
        codex: [claude3, claude4, claude5, claude6]
      reviewer_allow: [codex4, codex5, codex7, codex8, claude3, claude4, claude5, claude6, codex2, codex3, claude1, claude2]
      service_profiles: [denis20x]
      review_deny: [codex1, chatgpt-countix, fable-analyst, fable-analyst2, ultra-scout]
```

```yaml
    tests:
      history_command: [countix-remote-test, history, --json, --sha, '{sha}']
      status_command: [countix-remote-test, status, --json, --lane, '{lane}']
      full_suites: [api, full-tuned, full]
    pipeline:
      merge_queue:
        enabled: true
        ask_paths: ['**/booking/**', '**/vat/**', '**/payroll/**', '**/payments/**', '**/billing/**', '**/rls/**', '**/auth/**', 'migrations/**']
        deny_lanes: [main, master, 'release/*', 'prod-*']
        require_pr: false
        github:
          repo: dbenic/Wavepulse
          token_file: /home/wave/.config/wavecode/github-token   # SystemOps stores it; never in chat or the repo
          ok_label: ask-tier-approved
          hold_labels: [migration-hold, do-not-merge]
        stall_minutes: 30
        maestro_log: /home/wave/inbox/wavecode-merge-queue.log
        gate_command: [countix-remote-test, --suite, full]   # the one full run, on the merged code
```

Testing rule from the study of 25 Oct 2026: on push the agent runs lint, types and the
related tests locally; at freeze one run per branch (quick suite plus the API tests for
the changed parts; the full API suite only when migrations, the database, sign-in or the
test setup change); the merge queue runs the full suite once on the merged code; a full
run on main nightly. Since the merge-queue brief of 26 Oct 2026 WaveCode's automatic
gate is on again (`auto_gate: true`, at most `gate_max_inflight` runs at once) so the
exact-SHA gate the queue needs is always submitted.

`auto_freeze` is on since 26 Oct 2026; agents may still write their own freeze notes.
`codex6` is not in the pools until its lane clearance is confirmed. `auto_stage` stays off; `auto_merge_main`
is on so the other lanes are told when the queue advances main.
