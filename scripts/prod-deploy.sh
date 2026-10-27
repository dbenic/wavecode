#!/bin/bash
# prod-deploy — WaveCode's deterministic production runner (releases.production_command).
#
# Runs on the deploy box as the WaveCode service user. Checks out ONE exact SHA on production
# over a restricted SSH alias, builds, reloads and verifies, following
# docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md of the app. Prints staging-schema progress lines
# (one JSON object per line) that WaveCode streams onto the release record: a `done` line is
# deployed, a `failed` line is failed. No LLM, no shell on the remote beyond the app dir.
#
# Never runs migrations. A SHA that adds a file under migrations/ since the SHA production runs
# is refused: those releases go through declared prerequisite steps (plan step 4) or SystemOps.
#
# Usage: prod-deploy --exact-sha <40-hex> --release <id> [--progress-json]
# Environment (set in the daemon unit, never in this file):
#   PROD_SSH_ALIAS   ssh config alias of the production deploy user (restricted key)
#   PROD_APP_DIR     app directory on production (default /var/www/wavepulse)
#   PROD_REPO_DIR    local clone used to verify the SHA is on origin/main
#   PROD_HEALTH_URL  public health URL (default https://countix.ai/api/health)
#   PROD_READY_URL   release observer ready URL on production (checked over ssh; optional)
#   PROD_PM2_APPS    space-separated pm2 names to reload (default "waveflow countix-desk-intake")
set -euo pipefail

sha=""; release=""
while [ $# -gt 0 ]; do
  case "$1" in
    --exact-sha) sha=${2:-}; shift 2;;
    --release) release=${2:-}; shift 2;;
    --progress-json) shift;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "--exact-sha must be a full 40-hex commit id" >&2; exit 2; }
[ -n "$release" ] || { echo "--release is required" >&2; exit 2; }
: "${PROD_SSH_ALIAS:?PROD_SSH_ALIAS is not set}"
: "${PROD_REPO_DIR:?PROD_REPO_DIR is not set}"
app=${PROD_APP_DIR:-/var/www/wavepulse}
health=${PROD_HEALTH_URL:-https://countix.ai/api/health}
apps=${PROD_PM2_APPS:-"waveflow countix-desk-intake"}
deploy_id="$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:9}"
started=$(date +%s)
phase=""

line() { # phase status [extra-json-fields]
  local extra=${3:-}
  printf '{"v":1,"ts":"%s","deploy_id":"%s","sha":"%s","phase":"%s","status":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$deploy_id" "$sha" "$1" "$2" "${extra:+,$extra}"
}
fail() { # code message
  local msg
  msg=$(printf '%s' "$2" | tr -d '\n"' | cut -c1-300)
  line "$phase" fail "\"error\":{\"code\":\"$1\",\"msg\":\"$msg\"}"
  line failed ok "\"result\":\"FAILED\",\"exit_code\":1,\"duration_s\":$(( $(date +%s) - started )),\"error\":{\"code\":\"$1\",\"msg\":\"$msg\"}"
  exit 1
}
remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$PROD_SSH_ALIAS" "$@"; }

phase=queued; line queued start
phase=fetch;  line fetch start
git -C "$PROD_REPO_DIR" fetch -q origin main || fail FETCH "cannot fetch origin/main"
git -C "$PROD_REPO_DIR" merge-base --is-ancestor "$sha" origin/main || fail NOT_ON_MAIN "$sha is not on origin/main"
line fetch ok

phase=lock; line lock start
state=$(remote "cd $app && git status --porcelain --untracked-files=no | head -5; echo __SHA__; git rev-parse HEAD") || fail SSH "cannot inspect production"
dirty=$(printf '%s' "$state" | sed '/^__SHA__$/,$d')
prev=$(printf '%s' "$state" | sed -n '/^__SHA__$/{n;p;}')
[ -z "$dirty" ] || fail DIRTY "production has modified tracked files; stop"
[[ "$prev" =~ ^[0-9a-f]{40}$ ]] || fail PREV "cannot read the SHA production runs"
git -C "$PROD_REPO_DIR" merge-base --is-ancestor "$prev" "$sha" || fail REWIND "$sha does not contain what production runs ($prev)"
if git -C "$PROD_REPO_DIR" diff --name-only "$prev" "$sha" -- migrations/ 'db/migrations/' 2>/dev/null | grep -q .; then
  fail MIGRATIONS "this SHA adds migrations; use the declared prerequisite steps or SystemOps"
fi
line lock ok "\"prev_sha\":\"$prev\""

phase=predeploy_dump; line predeploy_dump skip "\"reason\":\"no migration changes\""

phase=checkout; line checkout start
remote "set -euo pipefail; cd $app; git fetch -q origin main; git merge-base --is-ancestor $sha origin/main; git checkout -q --detach $sha" \
  || fail CHECKOUT "checkout of $sha failed on production"
line checkout ok

phase=deps
if git -C "$PROD_REPO_DIR" diff --quiet "$prev" "$sha" -- package.json package-lock.json; then
  line deps skip "\"reason\":\"lock unchanged\""
else
  line deps start
  remote "set -euo pipefail; cd $app; npm install --include=dev --no-audit --no-fund >/dev/null" || fail DEPS "npm install failed"
  line deps ok
fi

phase=build; line build start
remote "set -euo pipefail; cd $app; npm run -s check:si-filing-runtime; npm run -s check:payroll-runtime; npm run -s build >/dev/null" \
  || fail BUILD "build or runtime checks failed on $sha"
line build ok

phase=reload_migrate; line reload_migrate start
for a in $apps; do remote "pm2 reload $a --update-env >/dev/null" || fail RELOAD "pm2 reload $a failed"; done
line reload_migrate ok

phase=verify; line verify start
sleep 5
live=$(remote "cd $app && git rev-parse HEAD") || fail VERIFY "cannot read the SHA after reload"
[ "$live" = "$sha" ] || fail VERIFY "production reports $live, expected $sha"
curl -fsS --max-time 20 "$health" >/dev/null || fail HEALTH "health check failed at $health"
if [ -n "${PROD_READY_URL:-}" ]; then
  ready=$(remote "curl -fsS --max-time 10 '$PROD_READY_URL'") || fail READY "release observer not ready"
  printf '%s' "$ready" | grep -q "$sha" || fail READY "release observer does not report $sha; reload the intake app"
fi
version=$(remote "cd $app && sed -n 's/.*APP_VERSION = \"\\([^\"]*\\)\".*/\\1/p' src/version.ts | head -1" || true)
line verify ok "\"health\":true,\"sha_match\":true"

phase=done
line done ok "\"result\":\"OK\",\"exit_code\":0,\"duration_s\":$(( $(date +%s) - started )),\"version\":\"${version:-}\",\"staging_sha\":\"$sha\",\"url\":\"$health\""
echo "RELEASED $release: $sha v${version:-?}" >&2
