#!/usr/bin/env bash
# Ops-lane E2E: Push-to-staging job, end to end, against a running WaveCode.
#
#   scripts/ops-e2e.sh --base-url URL --dev-token-file F --stager-token-file F \
#       --sha SHA --receipt-dir DIR [--dry-run] [--step-runner CMD]
#
# Env equivalents: WC_BASE_URL, WC_DEV_TOKEN_FILE, WC_STAGER_TOKEN_FILE,
# WC_E2E_SHA, WC_RECEIPT_DIR, WC_E2E_DRY_RUN=1, WC_STEP_RUNNER.
#
# Tokens are read from files into a 0600 curl header file and are never
# printed, logged, or put on a command line. --dry-run asserts the fixed
# stage steps but runs none of them (no real deploy). Without it, each step
# runs as `$STEP_RUNNER <step>` and must exit 0.
# Exit 0 only when every step prints PASS.
set -uo pipefail
set +x

BASE_URL="${WC_BASE_URL:-}"; DEV_FILE="${WC_DEV_TOKEN_FILE:-}"; STAGER_FILE="${WC_STAGER_TOKEN_FILE:-}"
SHA="${WC_E2E_SHA:-}"; RECEIPT_DIR="${WC_RECEIPT_DIR:-}"; DRY_RUN="${WC_E2E_DRY_RUN:-0}"; STEP_RUNNER="${WC_STEP_RUNNER:-}"
EXPECTED_STEPS="stg-quiet-check,stg-backup,stg-pause,deploy,stg-resume"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --dev-token-file) DEV_FILE="$2"; shift 2 ;;
    --stager-token-file) STAGER_FILE="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --receipt-dir) RECEIPT_DIR="$2"; shift 2 ;;
    --step-runner) STEP_RUNNER="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

FAILS=0
pass() { echo "PASS $1${2:+ — $2}"; }
fail() { echo "FAIL $1${2:+ — $2}"; FAILS=$((FAILS + 1)); }
finish() { if [ "$FAILS" -eq 0 ]; then echo "RESULT PASS"; exit 0; else echo "RESULT FAIL ($FAILS)"; exit 1; fi; }
die() { fail "$1" "$2"; finish; }

[ -n "$BASE_URL" ] || die args "base url is required"
[ -r "$DEV_FILE" ] || die args "dev token file is not readable"
[ -r "$STAGER_FILE" ] || die args "stager token file is not readable"
[[ "$SHA" =~ ^[0-9a-fA-F]{40}$ ]] || die args "sha must be 40 hex characters"
[ -n "$RECEIPT_DIR" ] || die args "receipt dir is required"
if [ "$DRY_RUN" != "1" ] && [ -z "$STEP_RUNNER" ]; then die args "set --step-runner or --dry-run"; fi
SHA="$(printf '%s' "$SHA" | tr 'A-F' 'a-f')"
BASE_URL="${BASE_URL%/}"

TMP="$(mktemp -d)"; chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT
hdr() { # token file -> header file, 0600; token never reaches stdout/argv
  local out="$TMP/$2.h"; umask 077
  printf 'Authorization: Bearer %s\n' "$(tr -d '\r\n' < "$1")" > "$out"; echo "$out"
}
DEV_H="$(hdr "$DEV_FILE" dev)"; STAGER_H="$(hdr "$STAGER_FILE" stager)"

# req <header-file> <METHOD> <path> [json] -> sets CODE, BODY (file)
req() {
  BODY="$TMP/body.json"
  local args=(-sS -o "$BODY" -w '%{http_code}' -H "@$1" -X "$2")
  [ $# -ge 4 ] && args+=(-H 'Content-Type: application/json' --data "$4")
  CODE="$(curl "${args[@]}" "$BASE_URL$3" 2>/dev/null)" || CODE=000
}
# js <expr over `b`> : evaluate on the last body
js() { node -e "const b=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')||'null');const v=($1);process.stdout.write(v==null?'':String(v))" "$BODY" 2>/dev/null; }

# 1. developer creates the stage job
req "$DEV_H" POST /api/ops/stage "{\"sha\":\"$SHA\"}"
JOB_ID="$(js 'b&&b.job&&b.job.id')"
if { [ "$CODE" = 201 ] || [ "$CODE" = 200 ]; } && [ -n "$JOB_ID" ]; then pass create-stage-job "job $JOB_ID ($CODE)"; else die create-stage-job "HTTP $CODE $(js 'b&&b.error')"; fi

# 2. cross-role claim is refused
req "$STAGER_H" POST /api/ops/jobs/claim '{"role":"scout"}'
[ "$CODE" = 403 ] && pass cross-role-claim-403 || fail cross-role-claim-403 "HTTP $CODE"

# 3. stager claims it
req "$STAGER_H" POST /api/ops/jobs/claim '{"role":"stager"}'
CLAIMED="$(js 'b&&b.job&&b.job.id')"; STATUS="$(js 'b&&b.job&&b.job.status')"
if [ "$CODE" = 200 ] && [ "$CLAIMED" = "$JOB_ID" ] && [ "$STATUS" = claimed ]; then pass stager-claim; else die stager-claim "HTTP $CODE job=${CLAIMED:-none} status=${STATUS:-none} $(js 'b&&b.reason')"; fi

# 4. fixed steps
STEPS="$(js 'b.job.payload.steps.join(",")')"
[ "$STEPS" = "$EXPECTED_STEPS" ] && pass fixed-steps "$STEPS" || fail fixed-steps "got '$STEPS'"
STEP_LOG=""
IFS=, read -r -a STEP_ARR <<< "$EXPECTED_STEPS"
for step in "${STEP_ARR[@]}"; do
  if [ "$DRY_RUN" = "1" ]; then pass "step:$step" "dry-run, not executed"; STEP_LOG+="$step=dry-run"$'\n'; continue; fi
  if $STEP_RUNNER "$step" >"$TMP/step.log" 2>&1; then pass "step:$step"; STEP_LOG+="$step=ok"$'\n'
  else fail "step:$step" "exit $?"; STEP_LOG+="$step=failed"$'\n'; break; fi
done

# 5. receipt + complete
FINAL=done; [ "$FAILS" -eq 0 ] || FINAL=failed
mkdir -p "$RECEIPT_DIR" && RECEIPT="$RECEIPT_DIR/stager-e2e-$JOB_ID-$(date -u +%Y%m%dT%H%M%SZ).md"
if { printf '# ops-e2e stage receipt\njob: %s\nsha: %s\ndry_run: %s\nstatus: %s\n\n%s' "$JOB_ID" "$SHA" "$DRY_RUN" "$FINAL" "$STEP_LOG" > "$RECEIPT"; } 2>/dev/null; then
  pass write-receipt "$RECEIPT"
else die write-receipt "cannot write under $RECEIPT_DIR"; fi
req "$STAGER_H" POST "/api/ops/jobs/$JOB_ID/complete" "{\"status\":\"$FINAL\",\"receipt_paths\":[\"$RECEIPT\"]}"
[ "$CODE" = 200 ] && pass complete "$FINAL" || fail complete "HTTP $CODE $(js 'b&&b.error')"

# 6. final state
req "$DEV_H" GET /api/ops/jobs
GOT="$(js "(b||[]).find(j=>j.id==='$JOB_ID')?.status")"
NREC="$(js "((b||[]).find(j=>j.id==='$JOB_ID')?.receipt_paths||[]).length")"
if [ "$CODE" = 200 ] && [ "$GOT" = "$FINAL" ] && [ "${NREC:-0}" -ge 1 ]; then pass final-state "$GOT, $NREC receipt"; else fail final-state "HTTP $CODE status=${GOT:-missing} receipts=${NREC:-0}"; fi
finish
