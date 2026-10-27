# Plan: production deploys through WaveCode (no Grok bots in the chain)

Written 27 Oct 2026 by the admin session for Denis. Status: step 1 built in WaveCode (`releases.production_command`), step 2 script written (`scripts/prod-deploy.sh`), nothing installed on the deploy box yet. Denis asked for the option to deploy outside the Grok bots on 27 Oct 2026.

## Today

A production release passes through three owners:

1. WaveCode on the dev box: merge queue, freeze, gates, reviews, Promote button (admin only, `releases.production_approvers` = denis, main-only, prerequisite gate).
2. Maestro (Grok, old box): freezes main, orders the full run, writes the GO line. pm-denis duplicates this from Slack.
3. SystemOps (Grok, old box): the only holder of a production deploy credential. Denis pastes the GO line in #sysops; SystemOps executes a hand-written runbook.

The Promote path exists but is dead on the deploy box: it hands the release to the `fable` agent as a prompt (an LLM on a rate-limited key), the box has no production deploy credential, and its WaveCode is 60 commits behind main.

## Target

Denis presses Promote in the Command Center (or sends the GO line to pm-denis, which only prepares the request). The deploy box runs a deterministic script, streams progress onto the release record, and the Release view shows the result. No agent can trigger it; no Slack text is a GO.

## Steps

### 1. `releases.production_command` (WaveCode, dev + deploy box)

- Config: `releases.production_command` argv template with `{sha}` and `{release_id}`, validated like `staging_command`. When set, a production release on the deploy box runs the command instead of prompting `deploy_agent`. NDJSON progress lines land on the record exactly as staging progress does (`staging-progress.ts` reused). Exit 0 = `deployed`, anything else = `failed` with the last lines as `error`.
- `releases.prod_health_command` (already in config) runs after the command and is the verification step.
- Tests: config validation, command path chosen over agent, progress and failure mapping. Docs: `docs/releases.md` section.
- Built 27 Oct 2026: config key, runner in `releases.ts` (progress stream shared with staging; a runner that reports another SHA is a failed release with the reason on the record), tests, docs.

### 2. The deploy script on the deploy box (ops, not WaveCode code)

`scripts/prod-deploy.sh` (written 27 Oct 2026), installed as `/home/ci/bin/prod-deploy`, mode 0755, no secrets inside. The SSH alias, app dir, repo clone and health URLs come from environment variables in the daemon unit. It refuses a SHA that adds migrations. Steps:

1. Refuse unless `<sha>` is a full 40-hex id and is an ancestor of `origin/main` (fetch first).
2. Over the production deploy SSH alias (key placed by Denis or SystemOps, restricted to the deploy user, no shell beyond the app dir): `git fetch`, verify the SHA is on origin/main there too, `git checkout --detach <sha>` (never pull past the approved SHA; codex4's finding 3), `npm ci`, build, `pm2 reload waveflow` + `pm2 reload countix-desk-intake`.
3. Emit NDJSON per step (`{"step":"checkout","status":"ok"}`); stop at the first failure and print the pm2 status.
4. Print `RELEASED <release_id>: <sha> v<version>` on success.

Migrations are NOT in this script. A candidate whose freeze note declares migration steps is refused by the prerequisite gate until step 4 below exists. That keeps SystemOps for migration windows only.

### 3. GO verification

- Promote stays admin-only and approver-listed. The request carries Denis's user name and role to the deploy box, which refuses any other name (`PRODUCTION_RELEASE_NOT_APPROVER`, already in code).
- pm-denis may create a *draft* release (new status `awaiting_go`, visible in the Release view with the SHA, gate run id and PASS files). Only Denis's own session turns it into a request. A seat token on the production path is refused.
- The Slack DM gains one line: "Open the Command Center and press Promote on <sha8>". No GO text is parsed from Slack, ever.

### 4. Migration windows as declared steps (later)

Freeze notes already declare `prereqs` with `kind: check | code`. Add `kind: ops` steps mapped to `releases.prereq_checks` commands on the deploy box: `disk_free` (ndjson, `>= 4` GB), `backup` (pg_dump through the same alias, sha256 recorded), `migrate <file>` (one SQL file, inside a transaction, ledger row), `writers_stop` / `writers_start`. The GO runs them in order and stops on the first failure, exactly what SystemOps' runbook does by hand. codex4's four findings on runbook r1 become the acceptance tests for this step.

### 5. Retire the Grok bots from releases

- Maestro: out of release coordination once pm-denis does freeze + full run + GO line (it has the same inbox and API). Maestro keeps whatever other duties Denis wants.
- SystemOps: executor for migration windows until step 4 has run twice cleanly; then observer only. #sysops stays as the audit channel where WaveCode posts each production release (bridge token already exists).

## What Denis provides

- A production deploy key on the deploy box (restricted command or restricted user) and the decision to place it there. The admin session never creates or reads it.
- GO for the deploy box WaveCode update to main (restart; no release in flight at that moment).
- The choice: pm-denis or Maestro as the one PM.

## Order and timing

Step 1 and 2 after tonight's release (one evening plus Denis's key). Step 3 the day after. Step 4 within the week. Step 5 when 4 has worked twice.
