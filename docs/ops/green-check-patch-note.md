# Patch note for SystemOps: staging and prod green-check call WaveCode's checker

Written 26 Oct 2026 for the drift of that day (merge queue "tier1 PASS" vs green-check
"GREEN quick|full"; reused result filed under donor 3857882f for 7e27b7d2). Apply after
Denis's OK. Keep the forward-only ancestor check exactly as it is; only the "is this SHA green"
decision moves.

## The one line

In `countix-green-check` (staging and prod deploy runners), replace the local parsing of the
gateway's verdict files with:

```bash
wavecode gate-status "$SHA" --require quick --json > "$TMP/gate-status.json"; rc=$?
```

For prod use `--require quick,api` (or whatever prod requires today). Then:

- `rc=0` → green, deploy may proceed;
- `rc=2` → no result yet (refuse with the report's `suites.<suite>.note`);
- `rc=3` → RED (refuse);
- `rc=4` → still running (refuse, retry later);
- `rc=1` → error (refuse and page: abbreviated SHA, daemon unreachable, tool error).

The JSON carries `verdict`, `exit_code`, `tree_sha`, per-suite `state`, `run_id`,
`finished_at`, `source`, `reused_from`, and `found[]` (every result for the SHA with `why` it
does not count). Put `suites.quick.run_id` and `suites.quick.note` in the deploy log instead of
the current "basis" line.

The CLI runs on countix-dev as any user that can read `/home/wave/wavecode/config.yaml`, or
with `WAVECODE_URL=http://127.0.0.1:3777` and `WAVECODE_TOKEN=<a token from wavecode-ops.md>`
in the environment; it needs no ssh to countix-testing (the daemon does the reads and caches
them). `$SHA` must be the full 40 characters; a prefix is exit 1.

## What changes in the decision

- `tier1` is `quick`. Confirmed in WaveCode's reader (`src/server/test-runs.ts`, "tier1 is
  stored as quick" since 12 Oct 2026) and in `countix-remote-test` ("default tier1 quick
  check"). The alias map is frozen in `src/server/gate-status.ts`.
- A reused run counts only when the donor's tree equals the target's tree. The checker compares
  `git rev-parse <sha>^{tree}` on both sides (your hand patch of 26 Oct, now in one place).
- RUNNING is never green; the latest finished run per suite wins.

## Second item, 26 Oct 2026 16:00 CET: `countix-remote-test` exit 5 after a GREEN

Four merge-gate runs on countix-testing printed `=== RESULT GREEN … exit=0 … ===`, then
`/srv/countix-test/bin/queue-record.sh: line 95: <pid> Killed sleep 2`, and the tool returned
`remote exit 5`. The suite had passed; the bookkeeping after it was killed. WaveCode now takes the
RESULT line as the verdict whatever the exit code (and records `exit_code: 5, state: GREEN` in the
`gate.result` event), and the four lanes were requeued. On the test host, please make
`queue-record.sh` not turn a killed `sleep` into the run's exit code (`sleep 2 || true`, or trap
the signal), so that the exit code and the RESULT line agree again. Runs seen: 20261026-155509-a9117d36c
(union lane merge), and the merges 18022ac1, c3e24768, eb54ad0c earlier today.
