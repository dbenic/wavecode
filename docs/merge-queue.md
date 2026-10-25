# Merge queue for main

Approved by Denis Benič on 25 Oct 2026 for **Wavepulse main only**. It replaces the
"Denis merges to main" rule for that one branch. Agents still never push to main by hand;
only the queue merges, and only on countix-dev. Staging and production are untouched: the
staging push stays with SystemOps and the production GO stays Denis's exact-SHA message.

## What merges

A freeze is eligible when all of these hold. The Reviews card shows the first one that
does not, as `Merge queue · waiting: …`.

1. **Freeze note** in the inbox naming the exact 40-character SHA and `TIER: ship|show|ask`.
   No `TIER:` line and no `default_tier` in config means the lane waits. A lane that
   touches an `ask_paths` glob or the migrations directory is `ask` whatever the note says
   (booking, VAT, payroll, payments, migrations, RLS and auth on Wavepulse).
2. **Green freeze-time run on that exact SHA**: the quick suite and the API tests for the
   changed parts (the full API suite when migrations, the database, sign-in or the test
   setup changed), as the test history reports them under `tests.quick_suites` and
   `tests.full_suites`. No waivers, no skipped suites. WaveCode submits nothing at freeze
   time (`auto_gate: false` since the testing study of 25 Oct 2026); the agent does.
3. **Reviews by tier**: `ship` needs none; `show` needs none before the merge (the pipeline
   has already asked a reviewer; their verdict lands afterwards); `ask` needs two
   `VERDICT: PASS` files from reviewers who are not the author and whose seats run on
   **different credential profiles**. Any verdict that says `NEEDS FIXES` or `REJECT` holds
   the lane until a new SHA is frozen.
4. **The remote lane still points at the frozen SHA.** A commit after the review moves the
   tip; the card says so and the author freezes the new SHA.
5. **A pull request exists** for the lane (`require_pr`, default on). With
   `pr_list_command` the open PRs are read from its JSON; without it the remote's
   `refs/pull/*/head` is matched, which cannot tell an open PR from a closed one.
6. **New migrations are numbered after main's latest** and do not collide with each other.
   A collision bounces the lane straight away.

The lane does not have to contain the current main: the queue merges main for it and
gates the result.

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
        require_pr: true
        maestro_log: /home/wave/inbox/wavecode-merge-queue.log
        gate_command: [countix-remote-test, --suite, full]   # the one full run, on the merged code
        # version_command: [node, scripts/bump-version.mjs]   # once the project says how a version is bumped
        # pr_list_command: [gh, pr, list, --json, 'number,headRefName,headRefOid,state']  # once gh is logged in for wave
```

## What it never does

Force-push, squash or rewrite a reviewed SHA, merge with a red or missing gate, merge an
`ask` lane on one review, push to staging or production, write a secret to a log, or
merge while either switch is off.
