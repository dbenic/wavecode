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
   is not a manual merge step and builders never merge.
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

## How it merges

One lane at a time per project, in the order lanes became eligible; an admin or developer
may raise a lane's priority. For the head of the queue WaveCode:

1. fetches main and the lane and checks the tip once more;
2. makes a detached checkout of main in `<repos>/.wavecode-merges/<repo>-<sha9>`;
3. runs `git merge --no-ff` of the lane SHA. A conflict aborts and **bounces** the lane
   with the files named;
4. runs `version_command` there if configured and folds its changes into the merge commit;
5. runs the **full suite once on the merge result** (`merge_queue.gate_command`, default
   `pipeline.gate_command`), as the author (`COUNTIX_REMOTE_TEST_WHO`), with
   `WAVECODE_SHA=<merge sha>`, `WAVECODE_LANE`, `WAVECODE_CHECKOUT` and
   `WAVECODE_MERGE_OF=<lane sha>`. It runs even when the lane already contained main:
   this is the only full run between the nightly ones. RED bounces; a dispatcher QUEUED
   or DUPLICATE answer retries on the next pass, three times at most;
6. checks the kill switch once more and pushes plainly: `git push origin HEAD:refs/heads/main`.
   Never `--force`, never a squash, never a different ref. A rejected push (main moved
   during the gate) merges again on the next pass;
7. records the audit row, tells the author's pane, appends one line to `maestro_log`,
   fires the `auto_merge_main` pings for the other lanes, and removes the checkout.

A bounced SHA stays bounced; the author fixes, pushes and freezes a new SHA, which starts
over. A daemon restart in the middle of a merge resets that row to queued; the checkout
is recreated from scratch.

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
- `POST /api/merge-queue/:sha/priority` `{ priority: 0-9 }` — developers and admins.
- `GET /api/reviews/board` — every card carries `queue` (`state`, `reason`, `tier`,
  `position`, `merge_sha`, `pr`) and the board carries `merge_queue.projects`.

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
        github:
          repo: dbenic/Wavepulse
          token_file: /home/wave/.config/wavecode/github-token   # stored by SystemOps, mode 0400, owner wave
          ok_label: ask-tier-approved
          hold_labels: [migration-hold, do-not-merge]
        stall_minutes: 30
        maestro_log: /home/wave/inbox/wavecode-merge-queue.log
        gate_command: [countix-remote-test, --suite, full]   # the one full run, on the merged code
        # version_command: [node, scripts/bump-version.mjs]   # once the project says how a version is bumped
```

## What it never does

Force-push, squash or rewrite a reviewed SHA, merge with a red or missing gate, merge
without an independent PASS, merge an `ask` lane without Denis's label, merge past a hold
label, push to staging or production, write a secret (the GitHub token included) to a log,
or merge while either switch is off.
