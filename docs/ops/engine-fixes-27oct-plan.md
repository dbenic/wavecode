# Engine fixes from the 27 Oct 2026 retro, and deliveries by desk number

Denis, 27 Oct 2026 23:40 CET: "plan the desk-number deliveries and the 5 fixes, start now, you have my deploy."
The retro (pm-denis): about 9 hours on bank posting, 2 of them real work. Five causes, one design gap.

## Status

| # | Cause | Change | State |
|---|-------|--------|-------|
| 1 | Nobody checks quota and current work before handing out a task | `create_task` with an agent refuses (409, with `free_agents`) when the agent's 5h/weekly window is under `autonomy.min_quota_pct` (default 10); a busy agent is accepted but the answer carries `agent_busy` with the free ones. Auto-dispatch skips agents under the floor (`agent.quota_low` event, once an hour). | built 27 Oct |
| 2 | The release review comes only at the end | Rolling candidate review: after every merge into main, review the diff since the last production SHA as a stage of the candidate delivery; by freeze time only the last merge is unreviewed. | planned (next) |
| 3 | Test time goes to replaced SHAs; no cancel, no priority | WaveCode side: when a lane moves, its old SHA's queued or running run is treated as dead and the new SHA is submitted at the front. Needs a `cancel <run-id>` on the test gateway (test box, Denis's side). | planned; waits for the gateway |
| 4 | WaveCode blocks without saying why | (a) A wait a person must end (hold, moved lane, red gate, missing PASS, release mode) is said once to the author and the driver seats (`deliveries.notify`) the first time it appears. (b) A GREEN full gate counts as the quick check too. (c) A gate the gateway ran on a cloud runner (`kind=dev, suite=gate`) counts as the full gate (6a8e1ec). | built 27 Oct |
| 5 | No release mode: during a freeze chosen lanes cannot land without Denis | `POST /api/merge-queue/:project/release-mode {lanes}` and the seat tool `set_release_mode`: only the named lanes (branch names or `desk:<n>`) land; every other eligible lane waits with `RELEASE_MODE`. The ON/OFF switch stays Denis's. Shown on the Reviews page. | built 27 Oct |
| gap | Moving old mappings to day 0 was not in the feature | One mandatory line in the room's spec template: "what happens to existing records". | room file; Denis or pm-denis |

## Deliveries by product-desk number

`deliveries.desk` (schema v30). A freeze whose note carries a desk number (`desk91-freeze-<sha>.md`, `Desk #134`) joins its lane to the open delivery of that desk, or opens one named `PD-<n>` (created_by `tracker`, since 24 h before the first freeze). `POST /api/deliveries` takes `desk` (134 or PD-134); `GET /api/deliveries?desk=134`. One open record per desk. Off with `deliveries.auto_desk: false`. The page shows the PD badge and takes a desk number in the form.

## How we will know it worked

The tracker's stall notices per delivery and the retro numbers: minutes in build before the first run, minutes waiting on GATE_NOT_GREEN with a green full run, time from the last merge to a green candidate, hand merges on GitHub (should be zero).
