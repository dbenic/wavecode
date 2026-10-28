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

## Churn audit and fixes (28 Oct 2026, afternoon)

A 24-hour audit on countix-dev found the day's time going into work WaveCode made for itself:
471 freezes (340 on lanes with nothing left to merge), 1,346 behind-main nudges to agents,
461 first-pass requests (283 timed out), 188 auto fix tasks that could never dispatch, and
25 freezes refused over a lane name read from prose. Four fixes:

1. **Sync loop retires a finished lane.** `onMainAdvanced` no longer merges main into a lane
   with no commit main lacks (`git cherry` empty): it retires the lane, tells the author once
   to switch the checkout to main, and stops. A merge-only freeze (same patch as an earlier
   PASS, main merged since) gets no first pass and no reviewer ping; the merge queue already
   carries that PASS and its api GREEN (patch-id rule). Note: `auto: merge-only delta from
   <sha8> — its PASS carries over`.
2. **Nudges once a day, and only for lanes nobody has checked out.** The behind-main nudge
   from the reconcile pass (`kind: 'freeze'`) repeats after 24 h, not 30 min, and is skipped
   when `auto_merge_main` is on and a seat's workspace has the lane (the sync pass handles it
   or says what blocks it). An open freeze whose lane has not been pushed for 48 h is closed
   as `stale` (`freeze.stale` event, author told once); a new push and freeze reopen it.
3. **WaveCode's own task runs on the seat it names.** A task with no creator that is assigned
   to an agent (the auto fix task after a needs-fixes verdict) is that agent's own work and
   dispatches regardless of the profile rule. The 188 stale ones from before this fix were
   cancelled by hand on the box.
4. **Lane names come only from a labelled field.** `Lane:`/`Branch:` need the colon right
   after the keyword; a colon later in a sentence no longer turns its first word into the
   lane. A stored real lane name outranks a parsed word that is not one.

### Hour-two measurement and three more fixes (28 Oct 2026, 14:00)

Re-measured 80 minutes after the restart: pipeline freezes 3/h (was ~20), first-pass
timeouts 1, bogus-lane refusals 0, 58 stale freezes closed, 17 lanes retired, merges resumed.
Three leaks were left:

5. **The freeze nudge repeats once a day per lane, whatever main is at.** It was keyed per
   (lane, main SHA), so main's five moves in 80 minutes drew 56 nudges on 26 lanes through
   the freeze-write and review-queue callers of `pingLaneAboutMain`, which bypass the
   reconcile pass's own check. `kind: 'freeze'` now consults `laneNudgedRecently(lane, 24 h)`
   first.
6. **A freeze with nothing main lacks is closed when it is recorded.** One seat wrote 14 hand
   freezes on 7 already-merged lanes in an hour, each costing a quick run, a gate run and two
   review pings. `onFreezeRecorded` now runs `git cherry main <sha>` on the frozen SHA (after
   the push check fetched the lane, so a stale ref cannot close a live lane); when it is
   empty the lane is retired (freezes `merged`, `pipeline.retired` event) and the author told
   once to start the next lane. The merge-only carry note is emitted once per SHA
   (`pipeline.carried`), not on every re-delivery of the file.
7. **A refused auto-freeze is said once.** `onAuthorDone` runs on every pane poll; one lane
   drew 16 "not on origin" notes in two minutes. `publishFreeze` keeps a two-minute quiet
   period per (lane, SHA) after a push-check refusal.

Still open after this: 76 pending tasks, 58 of them from before 26 Oct or on retired seats
(cancelled by hand); reviewer load (codex5) to be read after a day under the new rules;
`deploy_reconcile` over its 90 s ceiling and the test-portal timeout on the deploy box.

### Hour-three measurement: daemon load and five more fixes (28 Oct 2026, 16:00)

Measured again with a wider lens: the daemon ran at 72 % CPU and spawned 52,000 processes per
15 minutes, 20,700 of them `git merge-base`. Sampling the live processes showed the same two
ancestry questions five times a second: six freezes from 25 Oct with no lane whose commits were
never pushed, in a partial clone (blob:none), so every ask went to the remote three times, timed
out, and was never remembered. Also found: the delivery tick stalled the event loop 8 s a minute
(one event scan per open delivery), the owner's own tasks never dispatched (profile rule), and
refreeze bursts on migration collisions asked a first pass per refreeze (18 of 26 timed out).

8. **Delivery tick loads its signals once.** `deriveDelivery(id, signals?)` takes the pass's
   shared list; `deliveryTick` loads from the oldest open delivery's `since_at` in one query.
   Schema v33 adds `idx_events_type_created` (type, created_at) for that read.
9. **Git memo remembers failures for 10 minutes.** `gitRun` kept exit 0/1 forever and nothing
   else, so a missing object (128) or a timeout was asked again on every call. Ancestry and
   existence reads (`merge-base`, `cherry`, `rev-list`, `cat-file`, `rev-parse`) run with
   `GIT_NO_LAZY_FETCH=1`: they never need blob content, and a missing commit is missing.
10. **A freeze on a commit the repo does not have after a day is closed as stale** (reconcile
    pass, `freeze.stale`, reason "commit … is not in the repo after a day").
11. **The migration-collision bounce says what to do**: the latest number on main, the number
    to start at, and that the renumbering is done once after merging main.
12. **No second first pass on a lane refrozen inside 20 minutes** while the previous ask on that
    lane is unanswered (`auto: no first pass asked on … — @seat is still on …`).

13. **The deploy reconcile skips settled cards.** A card in production, or history (superseded, stale), with a known state on a
    freeze no longer open for review cannot change (prod moves forward only). The pass recomputed
    all 6,917 freezes in history, five git calls each, 25 minutes a pass back to back: that was
    about 90 git spawns a second and most of the daemon's CPU after the orphan storm was gone.
    Note for SysOps: `/usr/local/bin/tmux` on countix-dev is a wrapper that runs `id -u` and a
    cgroup grep before each real tmux call; at 20 tmux calls a second that is 40 extra processes
    a second. Not WaveCode's file.

Operations the same afternoon: profile `denis20x` marked `shared: true` on countix-dev (admins'
tasks dispatch to the seats again); the 16 stale pending tasks cancelled. Not changed: the gate
refusal after a supersede (the gateway keeps one queued run per agent; the retry lands in 90 s).

## Hour-four: the stall and the lane-tip storm (28 Oct 2026, 18:00)

Measured after the hour-three restart: 26/26 seats alive, CPU 25–50 %, one 1.3–1.9 s event-loop
stall a minute at a fixed phase, 28k `git rev-parse` and 18k `git merge-base` spawns per 15 min.

14. **Delivery tick (the stall).** The tick loaded every signal event since the oldest open
    delivery (16 Oct: 107k rows, 25 MB of JSON) every minute, parsed it, and walked it once per
    open delivery with `Date.parse` per event (46 deliveries x 107k = 4.9 M parses). Now the
    signals stay in memory between passes and a pass reads only rows with a higher id
    (`cachedSignals`); `created_at` is parsed once at load (`at_ms`); the loop yields to the
    event loop between deliveries; the pass is recorded as the `delivery_tick` job.
15. **Lane board overlap check.** For every lane on the board the overlap check asked git for
    the tip of every deployed staging release again (92 lanes x 40 releases = 3,500 `rev-parse`
    a pass, one lane asked 885 times a minute). Tips are read once per pass and the deployed
    lanes deduplicated.

## Seat prompts and replies (28 Oct 2026, 19:30)

A seat relayed a decision as "From pm-denis, Denis approved…"; the agent read the paste as
material to review and answered "I haven't started, [ ] Yes [ ] No" four times; the replies
sat in the thread (pull-only) and the seat was never told. Three changes:

16. **Replies go to the seat that asked.** A reply captured for a prompt sent through a seat
    token is typed into that seat's pane: `[reply from @claude4 to your 16:01 UTC prompt] …`
    (700 chars, full text in the thread). A reply that waits for a go-ahead
    (`replyWaitsForAnswer`: trailing question, "haven't started", "if you confirm",
    "[ ] Yes"…) is said loudly: `[@claude4 is WAITING FOR YOUR ANSWER … not working]`, and the
    thread marks it needs-attention.
17. **Seat prompts are marked as instructions.** Every prompt a seat sends is typed with
    `[from @pm-denis, denis's PM seat: this is your instruction, not relayed material]` in
    front (the thread shows the text as written).
18. **Seat brief.** Relay a decision as context, give the instruction in your own words; the
    answers come to your pane; a WAITING line means answer or re-send. Applies on the next
    rebrief (Denis's click) — the prefix and the reply push are live at once.
19. **Main-ref lookups.** The deploy reconcile asked git for origin/main once per card and the
    retire check once per lane (15 `rev-parse` a second); both go through the per-pass ref memo.
