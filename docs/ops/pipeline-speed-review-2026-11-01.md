# Pipeline speed review — agents, instructions, path to staging

Written 1 Nov 2026 08:30–09:30 UTC from the countix-dev box (WaveCode DB, config.yaml, room files,
agentdrop results) and the WaveCode source at b361a57. Numbers are measured, not estimated.
Question asked: how do we get a change in front of eyes on staging as fast as possible, should
reviewers be dedicated, and do we want two staging screens.

## 1. The short answer

- The engine is not slow at throughput: 211 lane merges to main since 31 Oct 00:00 UTC, first
  reviewer verdict 4 minutes after a freeze, a clean lane on main in 15–40 minutes.
- It is slow at **feedback**: nothing can be looked at until it is merged and someone deploys it
  to the one staging, which one seat locks for 45 minutes at a time. Staging saw 2 deploys
  yesterday and 2 today, against 15 a day a week ago.
- Half the lanes freeze 3 or more times before they merge (average 3.8 freezes per merged
  lane). Each extra freeze costs a quick gate, a first pass, a review and a queue cycle.
  That, not test time, is where the hours go.
- Two things stall work outright: rules that park tasks (profiles, leases, quota floors, seat
  dead letters) and named reviewers that never answer (10 freezes have waited over 19 hours
  for codex1 right now).
- Dedicated reviewers already exist in config (`reviewer_prefer`, `reviewer_allow`); they
  need a role and a send-back threshold, not a new idea.
- Two staging screens: yes, and the cheap version is a second stack on the deploy box with its
  own lock. The real fix is a preview per lane on the dev box, so a change is visible before
  review, not after merge.

## 2. The fleet

38 seats: 20 Claude Code, 13 Codex, 5 Kimi. Four are orchestrator seats (pm-denis, pm-ops,
pm-support, pm-antonio). Utilisation over the last 24 h from status changes:

| Group | Seats | Weekly window left | Share of day working |
|---|---|---|---|
| denis20x Claude (claude3–6, fable-analyst2) | 5 | reset 1 Nov 05:00 after 41 h at 0 % | 1–9 % |
| denis20x Codex (codex4–8) | 5 | 63–100 % | 6–20 % |
| assist (claude-t1, claude-t2) | 2 | 92 % | 10–14 % |
| ultra (ultra-claude1, ultra-claude2) | 2 | 62 % | 3 %, 0 % |
| denis / denis2 / pool | 7 | 23–88 % | 0–20 % |
| ales, antonio | 9 | 62–100 % | under 3 % |
| kimi (kimi1–4, kimi-e2e) | 5 | no cap | not tracked (41 runs) |

The busiest seat (codex2, codex4) works 20 % of the day. The fleet as a whole works about 7 %.
No task waited for "any free seat" this week; every stuck task was pinned to a seat by a rule.

Quota is a real stall, but a concentrated one: the five denis20x Claude seats sat at 0 % from
30 Oct 11:04 to 1 Nov 04:17 (41 h), the three antonio Claude seats for 34 h on 29–30 Oct. Those
windows were burned by the stale-freeze loop and review ping-pong, not by features. A second
subscription would have been burned the same way. **Do not buy capacity until the churn below is
fixed**; if the denis20x Claude window still reaches 0 % by Wednesday, add one Claude Max 20x on
its own account for lane work (seats on an existing account share its window and add nothing).

Blind spots: claude3 has no usage probe at all and claude4's is from 21 Oct, so the dispatcher's
quota check passes them blindly. Kimi seats never report `working`, so their utilisation is unknown.

## 3. Instructions the agents actually read

| Layer | Where | Size | Finding |
|---|---|---|---|
| WaveCode agent rules | `/home/wave/profiles/<p>/claude/CLAUDE.md` and `codex/AGENTS.md`, installed from `docs/agent-operating-rules.md` | 18.7 KB | Identical on ales, antonio, artem, denis, denis2, denis20x, pool. **Missing on assist, ultra, kimi.** claude-t1, claude-t2 and ultra-claude1 are the three authors with the most merges since 31 Oct (32, 27, 27) and run without the WaveCode rules. |
| Repo rules | `wavepulse/CLAUDE.md`, `AGENTS.md` | 26 KB + 2 KB | Loaded into every prompt. Contains standing rules for accounting-core and extraction changes. Fine, but it is the only rule set the three profiles above get. |
| Room | `rooms/wavepulse/` | LEDGER 77 KB, DECISIONS 1 KB, MIGRATION_RESERVATIONS 16 KB, KNOWLEDGE 2 files | **No SPEC.md, no ROOM.md.** The build and review templates tell agents to read both. |
| Orchestrator seat brief | `docs/orchestrator-seat.md` + `SEAT.md` in the seat workspace | 11 KB + 19.6 KB | `users.seat_rules` is empty for every user; standing rules live as addenda in SEAT.md, which only grows. |
| "Ready for staging" | agent rules, seat brief, lane chore prompt | 4 lines | Consistent in all three places: merge main, quick green on the exact SHA, freeze note, reviewer PASS. |
| pm-denis's own list | `seats/pm-denis/wavecode-improvement-items.md` | 15.7 KB, 30+ items | Already names most of the bugs found this week: show tier merging without a verdict, NEEDS FIXES ignored, api never green on a merged SHA, codex5 reviews unanswered, duplicate notices, hold lanes auto-synced. Treat it as the backlog. |

## 4. Where the time goes between "done" and "on main"

Lane freezes merged since 31 Oct 00:00 UTC (after the 30 Oct churn fixes):

| Stage | Measured |
|---|---|
| Freeze → first verdict | 4 min average |
| Freeze → merged, average | 105 min |
| Freeze → merged, distribution (211 merges) | 57 under 30 min · 55 in 30–60 · 53 in 1–2 h · 25 in 2–6 h · 21 over 6 h |
| Freezes per merged lane | 3.8 average · 45 lanes once · 39 twice · 77 three to five · 50 more than five |
| Full gate run (when it runs on the lane SHA) | queued 5 min after freeze, runs 14 min |
| Ask tier (payroll, vat, booking, migrations…) | 16 queued, 70 min freeze → merge |
| Show tier | 40 queued, 124 min freeze → merge |

Pipeline actions per merge over three days: 3.3 gate, 2.8 quick, 2.3 first pass, 1.8 review and
0.4 candidate review per lane that landed. A lane SHA passes through **four review-like stages**:
first pass (codex2/codex3), reviewer verdict, merge-queue gate, candidate review after landing.

Reviewer behaviour since 31 Oct:

| Reviewer runtime | Verdicts | Sent back |
|---|---|---|
| Codex | 335 | 38 % |
| Kimi | 162 | 31 % |
| Claude | 73 | 7 % |

Codex reviewers are the configured first choice for Claude lanes, and they send back more than a
third of freezes, usually one finding at a time. A 12-freeze lane yesterday was seven Codex
findings filed one per round.

What stalled for whole days during the churn week (29–30 Oct): three lanes with migration-number
collisions and one with a package.json conflict were bounced 1,400 and 456 times over 36 hours,
once every few minutes, until they were retired. Since 31 Oct bounces are down to single digits.

Open right now: 26 freezes `open` (average age 14 days) and 55 `behind-main` (11 days). These are
retired lanes nobody closed; they generate stale notices and skew every queue view.

## 5. Staging today

- One staging: `https://countix-staging.tailf32df0.ts.net:8443`, stack under `/srv/staging` on the
  deploy box, deployed by the agentdrop job `staging-deploy` (caller `staging-ops`).
- Precondition: quick gate GREEN on the exact SHA. The deploy itself takes about one minute
  (06:48:31 start → 06:49:17 done this morning).
- **Lock**: the requesting seat holds staging for 45 minutes, renewable once. This is the
  "one screen" problem in one line.
- Who deploys: 15 different seats in seven days, mostly agents checking their own lane
  (ales-claude1 11, codex-antonio 9, codex2 7, pm-denis 4).
- Volume: 15, 11, 11, 8, 9, 2, 2 deploys per day from 26 Oct to 1 Nov.
- **WaveCode has no record of any of it.** `release_requests` holds five production requests from
  28 Oct and zero staging requests in seven days. The Release page cannot show what is on staging
  because staging goes through chat and agentdrop, not through `releases.staging_command`
  (documented in `docs/peers.md`, not configured on the deploy box).

## 6. Recommendations, in order of payoff

### 6.1 Make a change visible before review, not after merge

**This week: a second staging screen.** Duplicate the `/srv/staging` stack on the deploy box as
`staging-b` (own database, own port, own lock), teach `staging-deploy` a `--target` flag, and let
WaveCode name the target. WaveCode's `ReleaseTarget` is `staging | production` today; it needs
`staging-b` (or a list of named staging targets) and a lock per target. Configure
`releases.staging_command` on the deploy box so the Stage button on a freeze card deploys and the
Release page shows which SHA is on which screen. Cost: a day of deploy-box work plus a small
WaveCode change.

**Next: a preview per lane on the dev box.** When a lane freezes (or on a `preview` verb from
pm-denis), start the stack from the lane's worktree with a copy of the staging seed database at
`https://<lane>.countix-dev.<tailnet>/`; tear it down when the lane retires or merges. Denis,
pm-denis and kimi-e2e look at the feature while the review runs. This removes the staging lock from
the critical path entirely and makes "two screens" into "as many as there are lanes". It is the
one change that gives the local-development feeling without leaving the system.

### 6.2 One review per feature, not one per SHA

- Lanes outside `ask_paths` (no payroll, vat, booking, payments, billing, rls, auth, migrations):
  one reviewer, and a send-back needs a blocking finding. Smaller findings go on the PASS as
  notes for the author to fix in the next lane. This is a reviewer brief change, not code.
- Lanes inside `ask_paths`: keep two independent PASSes, keep any NEEDS FIXES blocking (fix
  branch `claude/bold-mestorf-1eb676`, commit e366095, not yet pushed).
- First pass (codex2/codex3) and the reviewer verdict overlap for small lanes. Skip first pass
  under 10 changed files, or make first pass the only review for UI-only lanes.
- Do not auto-sync main into a frozen lane that is waiting for a verdict; the queue's landing
  merge already handles "behind main", and the re-freeze voids the review (pm-denis item,
  28 Oct 14:08). This alone attacks the 3.8 freezes per lane.
- Reuse the verdict when the patch-id did not move (`pipeline.carried` already fires 192 times in
  three days; make it the default rather than the exception).

### 6.3 Dedicated reviewers, done properly

Config already prefers codex4/5/7/8 for Claude lanes and claude3–6 for Codex lanes, with an allow
list of 16 seats. Make it a role:

- Reviewer pool: codex4, codex6, codex7, codex8, kimi1–kimi4, claude2. Reviewers take no lanes and
  no fix tasks, so they are always idle and pick up within a minute. Codex and Kimi have the
  spare window; Claude seats keep theirs for building.
- Add `role = reviewer` on the agent row so the picker prefers them and pm-denis cannot hand them
  a lane by accident (a lease would hide them from the picker, so a role is the right tool).
- Picker skips a reviewer who left the last three reviews unanswered or sits under the quota floor
  (card proposed last night). Named reviewers get the same 10-minute reassignment as auto-picked
  ones: codex1 is named on five freezes that have waited over 19 hours.
- Send-back threshold in the reviewer brief, see 6.2. Without it, a Codex pool at 38 % send-back
  makes the ping-pong worse.

### 6.4 Stop the stalls that are rules, not work

- Lease rule: a creator-less fix task for the seat's own lane must pass the owner check
  (`leases.ts` `waitReason`). It parked five claude-t1/t2 fix tasks all of yesterday and holds
  codex5's own fix task now.
- Tasks addressed to an orchestrator seat are never dispatched and record no wait reason. Turn a
  CLI send to a seat into a pane message.
- Per-profile quota floor (`profiles.<p>.min_quota_pct`, card proposed) so the assist seats stop at
  40 % left as Denis wants, without a global floor change.
- Migration numbers: WaveCode assigns the next free number at freeze from
  `MIGRATION_RESERVATIONS.md` and renumbers in the landing merge, instead of bouncing the lane
  every few minutes for 36 hours.
- Retire the 81 stale freezes (26 open, 55 behind-main, all older than ten days) and add a
  `retire lane` verb for pm-denis.
- Full-gate backlog after restart (card proposed): persist the queue, recover merged rows, age out
  legacy QUEUED words so releases stop being refused with "api still running".

### 6.5 Instructions

- Install the agent rules on the assist, ultra and kimi profiles (`scripts/install-agent-rules.sh`).
- Write `rooms/wavepulse/SPEC.md` and `ROOM.md`, or drop the two file names from the build and
  review templates. Today every template asks for files that do not exist.
- Move the standing rules out of SEAT.md addenda into `users.seat_rules` (2 KB cap forces them to
  stay short) and let SEAT.md be memory only.
- Adopt `wavecode-improvement-items.md` as the WaveCode backlog; it is already the best bug list
  there is.

## 7. What this buys

| Measure | Today | After 6.1–6.4 |
|---|---|---|
| Change visible to Denis | after merge + staging lock, hours | at freeze, minutes, per lane |
| Freezes per merged lane | 3.8 | 1–2 |
| Lane on main (show tier) | 124 min average | under 30 min |
| Staging screens | 1, locked 45 min | 2 fixed + 1 preview per lane |
| Review pickup | minutes, or 19 h when the named reviewer is silent | under 10 min, always |
| Claude weekly windows | drained by reviews and re-freezes mid-week | reserved for building |

## 8. Owners and order

1. Deploy box (needs Denis or an ops seat with deploy access): staging-b stack, `staging-deploy --target`, configure `releases.staging_command` and `staging_watch_command`.
2. WaveCode (this repo): named staging targets; reviewer role + picker skips + named-reviewer reassignment; lease rule for own fix tasks; seat-addressed CLI sends become messages; migration number assignment at freeze; no auto-sync of frozen lanes awaiting a verdict; stale-lane retire verb; per-profile quota floor; full-gate queue persistence. Three of these already have cards from last night; the merge-queue NEEDS FIXES fix is committed on `claude/bold-mestorf-1eb676`.
3. Box config (restart at zero running runs): reviewer pool, review thresholds in briefs, agent rules on the three profiles, room SPEC.md and ROOM.md.
4. Design, after 1–3: preview per lane on countix-dev.
