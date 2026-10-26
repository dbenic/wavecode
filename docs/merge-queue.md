# Merge queue for main

Approved by Denis Benič on 25 Oct 2026 for **Wavepulse main only**. It replaces the
"Denis merges to main" rule for that one branch. Agents still never push to main by hand;
only the queue merges, and only on countix-dev. Staging and production are untouched: the
staging push stays with SystemOps and the production GO stays Denis's exact-SHA message.

## What merges — evidence, not names

Stabilised on 26 Oct 2026 (Maestro's brief, Denis's "lets do this"). There is **no
allowlist**: any branch with a freeze note may queue unless it is on the deny list
(`main`, `master`, `release/*`, `prod-*`, the project's main branch; `deny_lanes` in
config). A freeze is eligible when all of these hold. The Reviews page shows the first
one that does not, as one machine-readable code and what is missing.

1. **Freeze note** in the inbox naming the exact 40-character SHA. `TIER: ship|show|ask`
   is read when present; without it the lane is `show` (or `default_tier`). A lane that
   touches an `ask_paths` glob or the migrations directory is `ask` whatever the note says.
2. **Green freeze-time gate on that exact SHA** (`GATE_NOT_GREEN` until then): the quick
   suite and the API tests for the changed parts, as the test history reports them under
   `tests.quick_suites` and `tests.full_suites`. No waivers, no skipped suites.
3. **One independent PASS on that exact SHA** (`NO_PASS_ON_SHA` until then): a
   `VERDICT: PASS` from a reviewer who is not the author and whose seat runs on a
   **different credential profile** than the builder's (the home-dir login counts as a
   profile). Every tier needs it; `ask` adds Denis's OK. A verdict that says
   `NEEDS FIXES` or `REJECT` holds the lane (`NEEDS_FIXES`) until a new SHA is frozen.
4. **Ask tier: Denis's OK label** on the lane's open pull request (`github.ok_label`,
   default `ask-tier-approved`), else `ASK_TIER_NO_OK`. Ship and show auto-merge: Denis
   is not a manual merge step and builders never merge. With `ask_tier: auto` (countix-dev
   since 26 Oct 2026, Denis: "I don't want to approve anything") no label and no pull
   request is needed: ask-tier lanes merge like the rest. A hold label still parks the lane.
5. **No hold label** on the pull request (`github.hold_labels`, default `migration-hold`
   and `do-not-merge`), else `MIGRATION_HOLD`. This is how a migration that must wait for
   a release (0394 before R7) is parked without touching the lane.
6. **The remote lane still points at the frozen SHA** (`LANE_MOVED` / `LANE_GONE`). A commit
   after the review moves the tip; the author freezes the new SHA.
7. **A pull request exists** only when `require_pr: true` (`NO_PR`). Default off.
8. **New migrations are numbered after main's latest** and do not collide with each other,
   else the lane bounces at once (`MIGRATION_COLLISION`).

The lane does **not** have to contain the current main: the queue merges main into it in
the merge checkout and gates the result, so a lane behind main is never refused for that.
Every waiting lane is re-evaluated against the current main on each pass; when a merge
advances main, the other lanes are told (`auto_merge_main`).

### GitHub

The queue reaches GitHub through `gh` with a **server-side credential** that depends on no
person's session: a fine-grained token (contents, pull_requests, checks on the repo) in
`github.token_file`, stored by SystemOps, readable by the service user only, never in chat
or in the repo. WaveCode reads it at tick time and hands it to `gh` as `GH_TOKEN`; it is
never logged, never in an event, never in a row. `gh auth status` is checked at the start
of every pass (cached five minutes when it passes). While it fails, **every** lane reads
`GH_AUTH_MISSING: <why>`, nothing merges, and the stall file goes out at once.

### Refusal codes

| code | missing evidence |
|---|---|
| `GATE_NOT_GREEN` | quick or api not green on the exact SHA |
| `NO_PASS_ON_SHA` | no PASS from a non-author on another profile than the builder |
| `NEEDS_FIXES` | a reviewer said NEEDS FIXES or REJECT on this SHA |
| `ASK_TIER_NO_OK` | ask tier without Denis's label on the pull request |
| `MIGRATION_HOLD` | the pull request carries a hold label |
| `LANE_MOVED` / `LANE_GONE` | the remote tip is another SHA / the lane is not on the remote |
| `LANE_DENIED` | the branch is on the deny list or denied for automation |
| `NO_PR` | `require_pr` is on and no open pull request matches |
| `MIGRATION_COLLISION` | a new migration is numbered at or below main's latest (bounced) |
| `GATE_DISPATCH_FAILED` | the gate tool failed before any suite ran (gateway policy, host unreachable, SHA already in flight); retried, bounced after three tries |
| `ALREADY_ON_MAIN` | the SHA is in main already, or every lane commit has an equivalent there (the merge would be empty); the row is superseded, the freeze stays for the overview's deploy tracking |

The runner's own `=== RESULT GREEN|RED … ===` line is the verdict on the merge result, whatever
the tool's exit code afterwards: the countix-testing gateway's identical-tree reuse path prints
GREEN, then ends its queued placeholder with SIGTERM and returns 143, and on 26 Oct 2026 its
post-run bookkeeping (`queue-record.sh` killed) returned 5 after a GREEN and bounced four lanes.
Only a non-zero exit without a RESULT line is the tool's word (`GATE_DISPATCH_FAILED`).

A lane bounced by the tool rather than by the code goes back without a new freeze:
`POST /api/merge-queue/:sha/requeue { reason }` (admin) returns the row to waiting with the
attempts cleared and writes a `merge_queue.requeued` event; the freeze must still be live.
| `GH_AUTH_MISSING` | the GitHub credential is missing or `gh auth status` fails |
| `QUEUE_OFF` | eligible, but the kill switch is off |
| `NOT_CONFIGURED` / `NO_REPO` / `CHECK_FAILED` | config or repo problems; the text says which |
| `STALLED_MERGE` | (stall file only) an eligible lane waited past `stall_minutes` with no merge |

### Stall alarm

When the queue cannot run (`GH_AUTH_MISSING`, `QUEUE_OFF` with eligible lanes) or an
eligible lane has waited longer than `stall_minutes` (default 30) with no merge started
or finished in that window, WaveCode writes `wavecode-queue-stall-<yyyymmdd-hhmm>.md` in
`stall_dir` (default: the `maestro_log` directory) with the reason, the switch state and a
table of lanes, SHAs, states and ages, appends a `stall` line to `maestro_log`, and emits
`merge_queue.stall`. One file per window; the Reviews page shows the stall first. A merge
clears it.

### Asking for a review yourself

After development the author asks, nobody waits for a pick: drop
`<you>-<lane>-review-request-<sha8>.md` in the freeze inbox with `Lane:` and the exact
SHA (optionally `Reviewer: @seat`). WaveCode pings the least-loaded eligible seat on a
different profile (or the named seat, through the ladder's checks), notes it on the lane,
and tells the author's pane what happened. It works with `auto_review` on or off, and a
second request on the same SHA moves the review when the first seat has not answered.
The same ask over HTTP: `POST /api/reviews/lanes/request-review { project, lane }` with no
`reviewer`. The freeze note must exist first: it is what the reviewer reads.

## Cleaning the list

Rows leave the queue on their own: a newer freeze on the same lane retires the older one
(open or behind-main) as `stale`, unless the older one is the lane's current tip (then it is
the live one whatever its age); a freeze closed by an admin (resolve, reset) stays closed; work that is already in main shows `ALREADY_ON_MAIN` and
the row is superseded. For everything else there is one supported bulk route, for admins:

```
POST /api/merge-queue/<project>/resolve
{ "shas": ["9d623bc7", …], "reason": "SysOps triage 26 Oct: branch deleted on origin", "status": "stale" }
```

Each listed freeze (7- to 40-character SHA) is closed with the reason kept as its
`superseded_by`, and its queue row turns superseded; `status: "merged"` records work that
reached main some other way. Freezes that are not open, not this project's, mid-merge or
unknown are skipped with the reason. Never edit the database by hand for this.

### Starting over

When the list is mostly stale (a day of conflicts, lanes nobody refroze), an admin resets it:

```
POST /api/merge-queue/<project>/reset
{ "reason": "queue reset 26 Oct — merge main, gate, refreeze" }
```

Every row that is waiting or bounced (or only one of the two, with `"states": ["bounced"]`) turns superseded with that reason, and its freeze, when
still open (open, behind-main or rejected), is closed as `stale` with the same reason so the
lane can refreeze. Rows that are queued, merging, merged or already superseded are not
touched, no branch is touched, the history stays. The answer lists each row (`was`, what
happened to its `freeze`) and the counts left per state; one `merge_queue.reset` event
carries the SHAs. Authors then merge main, get the gates green and freeze the new SHA.

## How it merges

The queue has its own clock: every 90 s it re-reads its lanes and tries the head, on top of
the turn it gets at the end of each deploy reconcile pass (which can take minutes when main
moves; each pass step now has a ceiling, 5–10 min, after which the pass moves on and the next
pass skips the step while it is still busy). Every pass writes a heartbeat, shown on the
Reviews page as "last queue pass N min ago" (`switches[].last_pass_at`), and a merge clears
the stall banner at once. One lane at a time per project, in the order lanes became eligible; only an admin
may raise a lane's priority (an agent seat is a developer and must not jump the others). For the head of the queue WaveCode:

1. fetches main and the lane and checks the tip once more;
2. makes a detached checkout of main in `<repos>/.wavecode-merges/<repo>-<sha9>`;
3. runs `git merge --no-ff` of the lane SHA. A conflict aborts and **bounces** the lane
   with the files named;
4. runs `version_command` there if configured and folds its changes into the merge commit;
5. runs the **merge gate once on the merge result** (`merge_queue.gate_command`, default
   `pipeline.gate_command`; on countix-dev the tier1 quick check, the full suite stays with
   the release gate before prod), as the author (`COUNTIX_REMOTE_TEST_WHO`), with
   `WAVECODE_SHA=<merge sha>`, `WAVECODE_LANE`, `WAVECODE_CHECKOUT` and
   `WAVECODE_MERGE_OF=<lane sha>`. It is skipped when the lane already contained main and
   the merge result is the lane's own tree (no version bump changed it) and the lane's quick
   and api gates are GREEN on that SHA: those gates ran on exactly that tree, so the row says
   `merge gate skipped: …` instead of `gate GREEN on …`. A lane that needed a real merge is
   always gated. RED bounces; a dispatcher QUEUED
   or DUPLICATE answer retries on the next pass, three times at most;
6. checks the kill switch once more and pushes plainly: `git push origin HEAD:refs/heads/main`.
   Never `--force`, never a squash, never a different ref. A rejected push (main moved
   during the gate) merges again on the next pass;
7. records the audit row, tells the author's pane, appends one line to `maestro_log`,
   fires the `auto_merge_main` pings for the other lanes, and removes the checkout.

A bounced SHA stays bounced; the author fixes, pushes and freezes a new SHA, which starts
over. A daemon restart in the middle of a merge resets that row to queued; the checkout
is recreated from scratch.

## One checker: is this SHA green?

Every reader of gate results goes through one function (`src/server/gate-status.ts`): the
queue's admission and merge steps, the Reviews page, agents and the deploy scripts. It answers
for the exact 40-character SHA and the suites you require:

```
wavecode gate-status <sha> --require quick,api [--project wavepulse] [--json]
GET /api/gate-status/<sha>?project=wavepulse&require=quick,api
```

Exit codes: 0 every required suite GREEN, 2 missing, 3 red, 4 running, 1 error (abbreviated
SHA, tool error, unreachable source). `--require` takes `quick`, `api`, `full` and `gate`
(any of the project's full suites). Canonical suite names are `quick`, `api`, `full`; the
frozen alias map reads `tier1` as `quick` (the gateway files tier1 runs as quick; WaveCode has
stored them so since 12 Oct 2026), `full-tuned` and `kind: gate` as `full`. Writers in WaveCode
use canonical names only.

Rules: the latest finished run per suite wins; RUNNING never counts as green; a result the
gateway reused from another SHA (its run id names the target, its row the donor, as with
`7e27b7d2` and donor `3857882f` on 26 Oct 2026) counts only when the donor's tree equals the
target's tree. On anything but all-green the report lists every result found for the SHA with
why it does not count, never just "none".

Sources: the gateway's history for the SHA and its recent history (reused results), WaveCode's
own `gate.result` records (one immutable event per gate the queue or the pipeline ran: SHA,
tree, suite, state, exit code, run id, RESULT line, donor and its tree, build), and the legacy
`pipeline.gate` words. A freeze note's own "quick check: GREEN" line is read only where the
checker finds nothing (rollout compatibility).

## Kill switch

Two switches, both required: `projects.<p>.pipeline.merge_queue.enabled: true` in
`config.yaml`, and the runtime flag an admin flips on the Reviews page ("Stop merging" /
"Start merging") or with `POST /api/merge-queue/<project>/switch {"enabled": false}`. Off
means nothing merges and nothing is pushed; queued lanes keep their place and show
`merge queue is off`. Who flipped the switch last is kept on every later merge's audit row.

## Audit

Each merge is a `merge_queue.merged` event and a row in `merge_queue`:

| field | meaning |
|---|---|
| `sha_in` / `sha_out` | lane SHA merged, merge commit now on main |
| `main_before` | main's tip before the merge |
| `pr`, `tier`, `author` | from the freeze and the PR check |
| `gate_runs` | test-history run ids on the merge SHA, when `tests` is configured |
| `verdict_files` | the PASS files that counted (ask tier) |
| `enabled_by` | who last switched the queue on |
| `at` | CET time |

Bounces are `merge_queue.bounced` with the reason; `merge_queue.queued`,
`merge_queue.requeued` and `merge_queue.switch` complete the trail. No secrets are written:
the log lines carry lanes, SHAs, PR numbers and run ids only.

Over ssh:

```bash
sqlite3 -readonly /home/wave/wavecode/wavecode.db "select created_at, type, entity_id, payload_json from events where type like 'merge_queue.%' order by id desc limit 30"
```

## Endpoints

- `GET /api/merge-queue[?project=]` — switches per configured project and the rows.
- `POST /api/merge-queue/:project/switch` `{ enabled }` — admin only.
- `POST /api/merge-queue/:sha/priority` `{ priority: 0-9 }` — admins only (since 26 Oct 2026; it was open to developers, which includes agent seats).
- `POST /api/merge-queue/:sha/requeue` `{ reason }` — admins only; a bounced row with a live freeze returns to waiting (404 unknown, 409 not bounced or freeze closed).
- `POST /api/merge-queue/:project/reset` `{ reason, states }` — admins only; `states` is required (`waiting` and/or `bounced`), there is no default (26 Oct 2026).

A lane's priority also orders WaveCode's own gate dispatch: a SHA with a higher merge-queue
priority takes the next free gate (and quick-check) slot ahead of older waiting ones.
WaveCode submits at most one of its own runs per author at a time, quick check before full
gate: the gateway keeps one queued run per agent name and cancels the older one when a second
arrives, so a second freeze by the same author waits (note: "waits for @author's other run").
- `GET /api/reviews/board` — every card carries `queue` (`state`, `reason`, `tier`,
  `position`, `merge_sha`, `pr`) and the board carries `merge_queue.projects`.

## Main is the only road to prod (26 Oct 2026)

Prod deploys only a SHA that (1) is on origin/main, (2) contains the SHA production runs now
(forward-only: no rollback, no branch cut from prod), and (3) has quick + api GREEN on that exact
SHA. One check answers for everyone: `wavecode deployable <sha>` (exit 0 YES, 2 NO, 1 error),
`GET /api/deployable/:sha`, and the Stage/Promote buttons when `releases.main_only: true`.
What prod runs is recorded with `wavecode prod-sha <sha>` (`POST /api/deployable/prod-sha`,
admin) after each deploy, falling back to the newest deployed production release WaveCode knows.

- **Every new main tip gets the api suite once** (author `main` on the gateway), so a main SHA
  has its own verdict and a RED main is visible. A lane whose full gate is RED while main is RED
  is told "probably not your lane" (`[MAIN_RED]`) instead of "fix".
- **Prod drift**: production on a SHA that is not on main shows a red banner on the Reviews page
  (`PROD_DRIFT` in `GET /api/merge-queue` stalls). WaveCode opens one sync lane per prod SHA,
  `wc-wavecode-prod-sync-<day>` (main with prod merged in, pushed, frozen under `wavecode`),
  unless an open lane already contains prod's SHA; a conflicting merge is handed to Maestro
  (`[PROD_SYNC_CONFLICT]`). The lane merges through the queue like any other.
- **Review reuse by patch-id (rule 3)**: when a lane's own change against its merge-base with
  main has the same `git patch-id --stable` as an earlier freeze on the lane with an independent
  PASS, that PASS and the donor's api GREEN carry over; the new SHA needs quick GREEN, nothing
  more. Any new line is a new patch-id and needs its own review. Event
  `merge_queue.review_reused` (once per SHA) names the donor and the reviewers.
- **Fast lane**: an admin sets `POST /api/merge-queue/:sha/priority`; the lane takes the next
  gate slot and the head of the queue, still gated (quick + api + one PASS).
- The SystemOps side is described in `docs/ops/main-only-deploy-patch-note.md`.

## Configuration

```yaml
projects:
  wavepulse:
    migrations_dir: migrations
    tests:
      history_command: [countix-remote-test, history, --json, --sha, '{sha}']
      status_command: [countix-remote-test, status, --json, --lane, '{lane}']
      full_suites: [api, full-tuned, full]
    pipeline:
      gate_command: [countix-remote-test, --suite, api]
      merge_queue:
        enabled: true
        ask_paths: ['**/booking/**', '**/vat/**', '**/payroll/**', '**/payments/**', '**/billing/**', '**/rls/**', '**/auth/**', 'migrations/**']
        deny_lanes: [main, master, 'release/*', 'prod-*']   # the default; there is no allowlist
        require_pr: false
        ask_tier: auto          # label (default) = Denis's OK label on the PR; auto = no label, no PR
        github:
          repo: dbenic/Wavepulse
          token_file: /home/wave/.config/wavecode/github-token   # stored by SystemOps, mode 0400, owner wave
          ok_label: ask-tier-approved
          hold_labels: [migration-hold, do-not-merge]
        stall_minutes: 30
        maestro_log: /home/wave/inbox/wavecode-merge-queue.log
        gate_command: [countix-remote-test, --suite, tier1]  # the quick check on the merged code (Maestro, 26 Oct 2026); the full suite stays with the release gate before prod
        # version_command: [node, scripts/bump-version.mjs]   # once the project says how a version is bumped
```

## What it never does

Force-push, squash or rewrite a reviewed SHA, merge with a red or missing gate, merge
without an independent PASS, merge an `ask` lane without Denis's label, merge past a hold
label, push to staging or production, write a secret (the GitHub token included) to a log,
or merge while either switch is off.
