# Engine fixes from the 27 Oct 2026 retro, and deliveries by desk number

Denis, 27 Oct 2026 23:40 CET: "plan the desk-number deliveries and the 5 fixes, start now, you have my deploy."
The retro (pm-denis): about 9 hours on bank posting, 2 of them real work. Five causes, one design gap.

## Status

| # | Cause | Change | State |
|---|-------|--------|-------|
| 1 | Nobody checks quota and current work before handing out a task | `create_task` with an agent refuses (409, with `free_agents`) when the agent's 5h/weekly window is under `autonomy.min_quota_pct` (default 10); a busy agent is accepted but the answer carries `agent_busy` with the free ones. Auto-dispatch skips agents under the floor (`agent.quota_low` event, once an hour). | built 27 Oct |
| 2 | The release review comes only at the end | Rolling candidate review: after every merge into main, WaveCode asks one seat to review the diff since the last reviewed candidate (first time: since the merge's own base), writes the request file, and records the answer on the candidate stage of the delivery. By freeze time only the last merge is unreviewed. | built 28 Oct |
| 3 | Test time goes to replaced SHAs; no cancel, no priority | WaveCode side: a newer freeze on the same lane stops WaveCode's own quick and gate runs on the old SHA (recorded as cancelled, never RED), drops them from the waiting lists, and the new SHA takes the next slot ahead of older waiters. The remote run is told to stop through `pipeline.cancel_command` once the gateway has a `cancel` verb (test box, Denis's side; spec below). | built 28 Oct (WaveCode side); gateway verb pending |
| 4 | WaveCode blocks without saying why | (a) A wait a person must end (hold, moved lane, red gate, missing PASS, release mode) is said once to the author and the driver seats (`deliveries.notify`) the first time it appears. (b) A GREEN full gate counts as the quick check too. (c) A gate the gateway ran on a cloud runner (`kind=dev, suite=gate`) counts as the full gate (6a8e1ec). | built 27 Oct |
| 5 | No release mode: during a freeze chosen lanes cannot land without Denis | `POST /api/merge-queue/:project/release-mode {lanes}` and the seat tool `set_release_mode`: only the named lanes (branch names or `desk:<n>`) land; every other eligible lane waits with `RELEASE_MODE`. The ON/OFF switch stays Denis's. Shown on the Reviews page. | built 27 Oct |
| 6 | The full gate ran before the quick: a red lane cost a 23-minute gate run before the 4-minute quick even started, and the quick waited behind the gate for the author's one gateway slot | Quick first, gate after: with `gate_with_quick` WaveCode submits the quick check, and the full gate only once it is GREEN. RED: no gate, the author is told, note on the lane. An author's own quick on the SHA counts; a quick refused three times lets the gate run anyway. | built 28 Oct |
| gap | Moving old mappings to day 0 was not in the feature | One mandatory line in the room's spec template: "what happens to existing records". | room file; Denis or pm-denis |

## Deliveries by product-desk number

`deliveries.desk` (schema v30). A freeze whose note carries a desk number (`desk91-freeze-<sha>.md`, `Desk #134`) joins its lane to the open delivery of that desk, or opens one named `PD-<n>` (created_by `tracker`, since 24 h before the first freeze). `POST /api/deliveries` takes `desk` (134 or PD-134); `GET /api/deliveries?desk=134`. One open record per desk. Off with `deliveries.auto_desk: false`. The page shows the PD badge and takes a desk number in the form.

## How we will know it worked

The tracker's stall notices per delivery and the retro numbers: minutes in build before the first run, minutes waiting on GATE_NOT_GREEN with a green full run, time from the last merge to a green candidate, hand merges on GitHub (should be zero).

## Rolling candidate review (cause 2), built 28 Oct 2026

- Trigger: every main advance the pipeline sees (`pipelineHooks.onMain`: a queue merge, or main moving with `auto_merge_main`).
  Switch `projects.<p>.pipeline.candidate_review` (default: on when `auto_review` is on).
- Base of the diff: the newest candidate review that already has an answer and is an ancestor of the new main; the first
  time, the merge's own `main_before`; failing that, the production SHA. Nothing to compare against: no request, one note.
- Reviewer: the usual picker (`chooseReviewer`), with the merged lane's author as the author to avoid. An unanswered earlier
  request on the same project is marked superseded; its delta is inside the new one.
- Request file: `<freeze_dir>/wave-candidate-<sha8>-<yyyymmdd>.md`, written by WaveCode with the merge list and the diffstat.
  The seat appends `ISSUES:` lines (`- [HIGH|MED|LOW] path:line — why`) and ends with one line `CANDIDATE REVIEW: PASS` or
  `CANDIDATE REVIEW: NEEDS FIXES`. The inbox watcher records it (`pipeline.candidate_review`, kind `result`).
- NEEDS FIXES: the merged lane's author and the driver seats (`deliveries.notify`) get one line with the file. PASS: a note.
  No answer after `candidate_review_timeout_min` (default 45): one line to the reviewer and the driver seats.
- Tracker: the candidate span of a delivery shows the reviewer as actor; NEEDS FIXES is its cause (a BLOCKED stall).
- API: `GET /api/candidate-reviews/:project?limit=20`.

## Run cancel on replaced SHAs (cause 3), built 28 Oct 2026

WaveCode side (live): when a freeze supersedes an older one on the same lane (`superseded_by`), `cancelRunsFor(oldSha)`
aborts WaveCode's own quick and full-gate submissions on the old SHA (the local `countix-remote-test` process is killed),
drops the SHA from the waiting lists, records `gate.result` with a `cancelled: superseded by <sha8>` dispatch failure
(the checker never reads it as RED), emits `pipeline.quick`/`pipeline.gate` with the word `CANCELLED`, and marks the new
SHA as "jumped": it takes the next free slot ahead of older waiters (admin priority still first).

Gateway side (Denis, on countix-testing): a `cancel` verb on the submit gateway, called by WaveCode as
`pipeline.cancel_command: ["countix-remote-test", "cancel", "{sha}"]` once it exists.

    countix-remote-test cancel <sha|run-id>
      cancels every queued or running run for that SHA submitted from this box (any suite, any who);
      prints one `CANCELLED <run-id>` line per run, or `NOTHING TO CANCEL`; exit 0 either way;
      a cancelled run is recorded in history with state `cancelled` and `superseded_by` empty
      (the result line, when the run had started, is `=== RESULT CANCELLED sha=… ===`, never RED).

Without the verb the remote run finishes on its own; WaveCode just stops waiting for it and moves on.

## Quick first, gate after (cause 6), built 28 Oct 2026

Before: `onFreezeRecorded` queued the quick check and the full gate together; the gate claimed the author's one gateway
slot first (the quick awaited the checker before submitting), so the quick waited ~23 minutes behind the gate and a RED
lane was known only after both. Now `queueQuickCheck` returns a decision (`off`, `submitted`, `known:green|red|pending`):
`submitted`/`known:pending` put the SHA in `gateAfterQuick`; the quick's own GREEN releases `queueFullGate`, a RED leaves a
`gate` note (`full gate not submitted on <sha8> — the quick check is RED`) and tells the author, a refusal given up after
three tries submits the gate anyway, a cancel drops the entry. `known:green` (the author's own quick) goes straight to the
gate; `known:red` gets no gate. The tick (`settleGatesWaitingOnQuick`) settles entries whose quick is not WaveCode's own run
(an author's run still in flight, or one lost to a restart) from the checker's word. A re-ingested freeze reads the quick
word instead of queueing the gate.

Effect: RED known in ~4 minutes instead of ~27; no gate run on a red SHA; one remote run per freeze until the quick is in.
