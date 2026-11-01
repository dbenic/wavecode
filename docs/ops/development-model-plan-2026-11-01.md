# Development model: how we get to main, staging and production with many agents and people

Written 1 Nov 2026 for Denis's question: *we have multiple agents, some develop, some review; we
push to staging to test and then merge to main, or merge to main faster, not sure which is better;
it must scale with several developers, some using their own local Claude to define features or UI;
we need the best plan forward and more stability than today.* Grounded in our own measurements
(`pipeline-speed-review-2026-11-01.md`, box data of 31 Oct–1 Nov) and the public research listed at
the end.

## 1. The short answer

**Merge to main fast. Test on staging after main, not before. Look at a feature before merge on a
preview that belongs to the lane, not on the shared staging.** That is what the research says for a
team that wants both speed and stability, and it is already how our merge queue works; the staging
step is what sits in the wrong place today.

Concretely:

1. **Main is the only long-lived branch.** Lanes are short-lived, one change each, frozen and merged
   within a day. No `staging` branch, no release branches. (Trunk-based development; DORA.)
2. **Staging is a mirror of main**, redeployed automatically on every queue merge. Nobody locks it,
   nobody deploys a lane to it. It answers one question: does main, as it will go to production, work?
3. **Previews per lane** replace "let me see it on staging". When a lane freezes, its worktree is
   started on the dev box at its own URL with a copy of the seed database and torn down at merge or
   retire. Denis, pm-denis, kimi-e2e and the reviewer look at the feature while the review runs.
4. **Production = a main SHA that passed the full gate on main.** The candidate list we already keep
   becomes the only release menu; promotion stays Denis's GO, by exact SHA.
5. **One review per feature, sized for review.** Small lanes (one thing, roughly a hundred to three
   hundred changed lines), one independent reviewer, a send-back only for a blocking finding, Ship /
   Show / Ask tiers by path and size. Four review-like stages per SHA today become two.
6. **People's local Claude sessions produce specs and mocks, not merges.** A feature enters as a
   spec file in the room (goal, acceptance checks, screenshot or mock), pm-denis cuts lanes from it,
   and the same pipeline applies to a lane pushed by a person as to one pushed by an agent.
7. **Stability comes from control systems, not from more approval**: fast automated gates, small
   batches, flaky tests quarantined, rules that cannot have exceptions enforced by hooks and the
   queue rather than by text in a brief, and the four delivery measures reported weekly.

The two choices Denis asked about compared on our own numbers:

| | Staging first, then main | Main first, staging mirrors main (recommended) |
|---|---|---|
| Where a change is seen | one shared screen, locked 45 min per seat, 2 deploys a day now | preview per lane at freeze; staging shows main continuously |
| Integration | lanes drift while they wait for the screen; 3.8 freezes per merged lane today | queue merges main into the lane and gates the result on every pass |
| Scales with people | no: the screen is the bottleneck, 15 seats fought over it a week ago | yes: previews are per lane, staging has no queue |
| What production gets | a lane that worked alone on staging | a main SHA that passed the full gate as a whole |
| Research | long-lived pre-merge environments and branches are the pattern DORA and trunk-based development warn against | DORA 2025: throughput and stability together need fast feedback, small batches, strong version control, platform quality |

## 2. What the research says, in one page

- **DORA 2025 (State of AI-assisted Software Development, nearly 5,000 respondents).** AI adoption is
  now positively linked to throughput but still negatively linked to delivery stability: more change
  volume without strong control systems means more failures. AI is an amplifier of what a team
  already has. The control systems named: mature version control, automated testing, fast feedback
  loops, loosely coupled architecture, and high-quality internal platforms, which is where the
  largest return was found. Only the two best team profiles (about 40 % of a sample that already
  skews modern) gain speed without a higher change-failure rate; in the others the extra speed is
  eaten by production failures. Lesson for us: fix the ways of working first; capacity second.
- **Trunk-based development.** One shared branch, everyone integrates at least daily, short-lived
  branches only for review and build checks, release from trunk with fix-forward for high-throughput
  teams, feature flags and branch-by-abstraction for work that spans releases, merge queues at scale.
  Long-lived development branches ("merge hell") are the anti-pattern. A `staging` branch is one.
- **Google engineering practices.** A change should be one self-contained thing with its tests;
  about 100 lines is usually fine, 1,000 is usually too large, 200 lines across 50 files is too
  large. Reviewers may reject a change for size alone. Review speed is a team-throughput question:
  first response within one business day for humans, and approval with comments ("LGTM with nits")
  is normal when the author can be trusted to fix them. For agent reviewers our budget is minutes.
- **Ship / Show / Ask (Wilsenach, on martinfowler.com).** Ship: straight to main, CI only. Show:
  pull request merged at once, feedback welcome afterwards. Ask: wait for a review. Prerequisites:
  CI/CD with feature toggles keeps main releasable, automated checks must pass, branches are short
  and rebased often, and the team talks before building. Mostly-asking teams hit a scaling wall: the
  review queue either degrades feedback or slows delivery. We have the tiers in the queue already.
- **Merge queues (Graphite, Mergify, Trunk guides).** Small PRs, batching several entries into one
  test run, removing a failing entry so it does not block the rest, quarantining flaky tests, keeping
  CI fast, and measuring time in queue, failure rate and throughput. A flaky failure looks like a
  real one to the queue and costs a re-test of everything behind it.
- **Ephemeral previews instead of shared staging (Plane engineering).** Shared staging broke down as
  the team grew: one team's migration blocked another's feature, combined states were unpredictable,
  flaky tests passed against stale state, staging drifted from production. Per-PR previews with a
  database each and automatic teardown brought "open PR to validated on real infrastructure" to
  about 15 minutes. Engineers had been skipping validation and relying on code review alone before.
- **Claude Code best practices (Anthropic).** Give the agent a check to run and ask for evidence,
  not "tests pass". Keep `CLAUDE.md` short; a rule that must never be broken belongs in a hook, a
  deny rule or CI, because a guideline may be judged not to apply. Review a diff against the spec in
  a fresh subagent that never saw the conversation. Use worktrees for parallel sessions.

## 3. Where we stand against it

| Practice | Us today (measured) | Gap |
|---|---|---|
| One long-lived branch, daily integration | Yes: lanes merge through the queue, 211 merges since 31 Oct, main merged into the lane on every pass | None in the model; the churn is in review, below |
| Small changes | Not enforced; freezes average 3.8 per merged lane, half the lanes freeze 3+ times | Size rule and split guidance; reviewer may bounce for size |
| Fast feedback before merge | First verdict 4 min after freeze; quick gate green needed; but nothing visible until merged and staged | Preview per lane |
| Staging | One screen, 45-min lock per seat, deployed by 15 different seats, 2 deploys a day now vs 15 a week ago, not recorded by WaveCode | Auto-deploy of main, no lock, recorded in `release_requests` |
| Review stages | Four review-like stages per SHA (first pass, verdict, queue gate, candidate review); Codex send-back 38 %, Kimi 31 %, Claude 7 %, often one finding per round | One reviewer per feature, blocking-only send-backs, carried verdicts |
| Ship / Show / Ask | Tiers exist (`ask_paths`, migrations → ask; default show); ask tier auto since 26 Oct | Use them: ship tier for docs and tests-only lanes; size in the tier rule |
| Flaky tests | Not quarantined; a red gate bounces the lane | Quarantine list in the gate, retry once, report flakes weekly |
| Rules without exceptions | Mostly text in briefs and CLAUDE.md (18.7 KB), missing on 3 profiles that authored the most merges | Hooks and queue checks for the few that matter; brief gets shorter |
| Specs | Templates ask for `SPEC.md` and `ROOM.md` that do not exist; features arrive as chat | Spec door with a template; local Claude sessions write to it |
| Measures | Many events, no weekly four-key report | Deploy frequency, lead time, change failure rate, time to restore from our own events |
| Platform (WaveCode) stability | 16 daemon restarts on 29 Oct (OOM), stale-freeze loops, dead-letter tasks | Already in progress this week; keep it first |
| Credentials | Fixed today: no seat on an API key, out under 5 % or logged out (PR 44) | Deploy and watch |

## 4. The target model

```
 person (+ own Claude)          agents (lanes, worktrees)              people's lanes
        │ spec + mock                     │                                  │
        ▼                                 ▼                                  ▼
  room SPEC/<feature>.md ──► pm-denis cuts lanes ──► lane: build, quick check, freeze (small SHA)
                                                        │
                      ┌─────────────────────────────────┼──────────────────────────────┐
                      ▼                                 ▼                              ▼
             preview per lane                 one review (tier: ship/show/ask)   quick gate on the SHA
             <lane>.countix-dev…              blocking findings only
                      └─────────────────────────────────┼──────────────────────────────┘
                                                        ▼
                                           merge queue → main (batched, flaky-aware)
                                                        │
                                   ┌────────────────────┼─────────────────────┐
                                   ▼                                          ▼
                       staging = main, auto-deployed                full gate on the main SHA
                       (no lock; staging-b holds a SHA for demos)   → candidate list
                                                                              │
                                                                              ▼
                                                            production: Denis GO on an exact candidate SHA
                                                            fix-forward; feature flags for half-done work
```

What changes for each party:

- **Agents** build smaller lanes, freeze once or twice, read one review, and never deploy to staging.
- **Reviewers** are a role (codex4/6/7/8, kimi1–4, claude2 proposed), idle by design, answer within
  10 minutes or are reassigned, and send back only for a blocking finding.
- **pm-denis** cuts lanes from specs, watches previews, retires lanes, and asks for production GO on
  a candidate SHA.
- **Denis** looks at previews and staging, gives production GO, and reads one weekly table.
- **People with their own Claude** write the spec and mock, or push a lane under `developers[]`
  globs; their Claude gets the repo `CLAUDE.md` and the operating rules, never a credential.

## 5. Moving-forward plan

### Phase 0, this week: stability of the platform (mostly under way)

1. Seat credentials policy live (PR 44 + box changes today). No API keys, out under 5 %, out when
   logged out, shown on the board.
2. Churn fixes from the speed review: no auto-sync of a frozen lane awaiting a verdict; carried
   verdicts when the patch-id did not move; NEEDS FIXES blocking in the queue (e366095, to push);
   named-reviewer reassignment after 10 minutes; retire the 81 stale freezes and add a `retire lane`
   verb; migration number assigned at freeze from `MIGRATION_RESERVATIONS.md`.
3. Daemon memory: OOMPolicy and the test-Postgres reaper are in; keep the restart count at zero for
   a week before anything else is added to the daemon.
4. Weekly measures from our own events, one table, from Monday 3 Nov: deploys to staging and to
   production per day; lead time freeze → main, main → staging, main → production; change failure
   rate (hotfix lanes and reverts over releases); time to restore (incident open → fix on
   production); freezes per merged lane; review send-back rate by reviewer; time in queue.

### Phase 1, week of 3 Nov: staging follows main

5. Staging deploys automatically on every queue merge of main (or at most every 10 minutes), through
   `releases.staging_command` on the deploy box so WaveCode records it and the Release page shows
   which SHA is on staging. Remove the per-seat staging lock and the `staging-deploy` verb from the
   agent rules.
6. `staging-b` as the second screen that *holds* a SHA (demo, long test, Denis's walkthrough), with
   its own lock, the only one that remains.
7. Full gate runs on main SHAs after merge; the candidate list is the release menu. Production stays
   on Denis's GO by exact SHA, fix-forward, no hotfix branch.
8. Reviewer role on the agent row, picker prefers role holders, skips silent or parked seats.

### Phase 2, weeks of 10 and 17 Nov: see it before merge, decide by size

9. Preview per lane on the dev box: at freeze (or `preview <lane>` from pm-denis) start the lane's
   worktree with a copy of the staging seed database at `https://<lane>.countix-dev.<tailnet>/`,
   tear down at merge or retire, link on the freeze card and in the review request. A daily job
   removes previews of closed lanes. No production data in previews.
10. Size rule in the reviewer brief and the queue: a lane that touches more than about 300 lines or
    15 files outside `ask_paths` is bounced for size with "split it", unless the freeze note says
    why (a generated refactor, a deletion). Ship tier for docs-only and tests-only lanes (CI only).
11. Flaky quarantine: a named list of suites or tests that are retried once and never bounce a lane
    alone; a weekly flake report; a flake that stays two weeks is a fix task.
12. Queue batching: test two or three eligible lanes together when the gate is the bottleneck,
    bisect on red. Measure time in queue before and after.

### Phase 3, from 24 Nov: specs and people

13. Spec door: `rooms/wavepulse/SPEC/<feature>.md` from a template (goal, user story, acceptance
    checks as commands or screenshots, paths touched, tier). A local Claude session writes it, a
    subagent reviews the diff against it before freeze ("every acceptance check implemented, every
    edge case tested, skip style"). The build and review templates stop asking for files that do not
    exist (`SPEC.md`, `ROOM.md`) and point at the spec instead.
14. Feature flags convention in wavepulse for work that spans more than one lane, so half a feature
    can sit on main dark; flag removal is part of the last lane's acceptance.
15. People's lanes: `developers[]` globs already scope the Reviews page; a person's lane goes through
    the same queue (same tiers, same gate, same one review). Their Claude gets the repo rules through
    the checked-in `CLAUDE.md` and `.claude/settings.json` hooks (protected paths, migrations
    numbering, formatter), never through a seat credential.
16. Rules that cannot have exceptions move from brief text to hooks and queue checks; the agent
    rules file shrinks and is installed on every profile (assist, ultra, kimi are missing it today).

### Not now

- Do not add a `staging` or `develop` branch, release branches, or a manual staging sign-off before
  main. All three slow integration and move the failures later.
- Do not buy capacity before the churn is measured down; the five denis20x Claude seats were drained
  by re-freezes and review ping-pong, not by features.
- Do not add a third reviewer stage or a human approval on show-tier lanes. Stability comes from
  gates and small batches, not from more asking.

## 6. What to measure and the targets

| Measure | Today | Target by end of Nov |
|---|---|---|
| Freezes per merged lane | 3.8 | 1.5 |
| Freeze → main, show tier | 124 min average | under 30 min |
| Change visible to Denis | after merge + staging lock, hours | at freeze, under 10 min, per lane |
| Staging deploys | 2 a day, locked, by 15 seats | every main merge, automatic, no lock |
| Staging recorded in WaveCode | 0 of the last 58 | all |
| Review send-back, Codex / Kimi | 38 % / 31 % | under 15 %, blocking findings only |
| Review pickup | minutes, or 19 h when a named seat is silent | under 10 min, always |
| Stale freezes open | 81 | 0, retired weekly |
| Daemon restarts | 16 on 29 Oct, 2 on 28 Oct | 0 unplanned per week |
| Change failure rate (hotfix lanes / releases) | not computed | computed weekly; falling |
| Seats on an API key | 2 keys exposed | 0 (probe says so) |

## 7. Decisions for Denis

1. Main first, staging mirrors main, previews per lane: confirm the model (one line).
2. The staging lock goes away for agents; `staging-b` is the one screen that can be held. OK?
3. Size rule: bounce for size above ~300 lines or 15 files outside `ask_paths`, with a stated
   exception in the freeze note. OK, or a different number?
4. Reviewer pool: codex4, codex6, codex7, codex8, kimi1–4, claude2 take no lanes. OK?
5. Preview budget on the dev box: one stack per frozen lane, roughly 1–2 GB each; cap at 6 at a time?

## Sources

- DORA 2025 report landing page: https://dora.dev/research/2025/dora-report/ and the Google Cloud
  announcement https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report
  (AI as amplifier; throughput up, stability down without control systems; platform quality).
- Independent reading of DORA 2025 (team profiles, who benefits):
  https://blog.robbowley.net/2025/10/01/dora-2025-ai-assisted-dev-report-some-benefit-most-dont/
- Trunk-based development: https://trunkbaseddevelopment.com/
- Google engineering practices, small changes: https://google.github.io/eng-practices/review/developer/small-cls.html
  and review speed: https://google.github.io/eng-practices/review/reviewer/speed.html
- Ship / Show / Ask: https://martinfowler.com/articles/ship-show-ask.html
- Merge queue practice: https://graphite.com/guides/best-practices-managing-merge-queue,
  https://graphite.com/guides/merge-queues-flaky-tests-deployment,
  https://docs.trunk.io/merge-queue/concepts-and-optimizations/batching,
  https://mergify.com/blog/when-to-outgrow-github-merge-queue
- Replacing shared staging with previews (Plane): https://plane.so/blog/how-we-replaced-shared-staging-with-ephemeral-deployment-preview
- Preview environment data handling: https://archman.dev/docs/testing-strategy/test-environments/ephemeral-environments-and-preview-apps
- Trunk-based development and staging as a tool, not a gate: https://learnagilepractices.substack.com/p/git-strategies-for-trunk-based-development,
  https://dev.to/jhall/how-to-switch-from-gitflow-to-trunk-based-development-3kph, https://xebia.com/blog/version-control-strategies-continuous-delivery/
- Feature flags vs branches (vendor views, read as such): https://statsig.com/perspectives/feature-flags-vs-feature-branches,
  https://www.getunleash.io/blog/what-tools-and-processes-are-available-for-effective-trunk-based-development
- Claude Code best practices (checks, hooks, short CLAUDE.md, spec review): https://code.claude.com/docs/en/best-practices
- Agent workflow guides (secondary): https://kilo.ai/articles/beyond-autocomplete,
  https://www.futureproofing.dev/resources/ai-native-team/agentic-coding-workflow-2026
