#!/bin/bash
# countix-testpg-reaper: the host reaper that wavepulse's warm test-Postgres pool expects
# (tests/setup/testPgPool.ts: "SystemOps reap on the label only"). Removes containers labelled
# com.countix.testpg=1 that are idle past their TTL (label com.countix.testpg.ttl, default 2 h,
# measured from /tmp/countix-testpg-last-used inside the container, else the created label) or
# whose checkout (label com.countix.testpg.repo) no longer exists. A container whose checkout is
# the cwd of a running vitest is never removed. Nothing in these containers is worth keeping.
# 29 Oct 2026: 331 of them (84 GB) had accumulated on countix-dev with no reaper at all.
set -u
DOCKER=${DOCKER:-/usr/bin/docker}
now=$(date +%s); removed=0; kept=0
busy_repos=$(for p in $(pgrep -f vitest 2>/dev/null); do readlink "/proc/$p/cwd" 2>/dev/null; done | sort -u)
while read -r id name created ttl repo; do
  [ -n "$id" ] || continue
  ttl=${ttl:-7200}; created=${created:-$now}
  last=$($DOCKER exec "$id" cat /tmp/countix-testpg-last-used 2>/dev/null | tr -dc 0-9)
  [ -n "$last" ] || last=$created
  [ "$last" -gt $((now * 100)) ] && last=$((last / 1000))   # a millisecond stamp
  reason=""
  if [ -n "$repo" ] && [ ! -d "$repo" ]; then reason="checkout gone"
  elif [ $((now - last)) -gt "$ttl" ]; then reason="idle $(( (now - last) / 60 )) min"
  fi
  if [ -z "$reason" ]; then kept=$((kept + 1)); continue; fi
  if [ -n "$repo" ] && printf '%s\n' "$busy_repos" | grep -qxF "$repo"; then kept=$((kept + 1)); continue; fi
  if $DOCKER rm -f "$id" >/dev/null 2>&1; then removed=$((removed + 1)); echo "removed $name ($reason)"; fi
done < <($DOCKER ps --filter label=com.countix.testpg=1 --format '{{.ID}} {{.Names}} {{.Label "com.countix.testpg.created"}} {{.Label "com.countix.testpg.ttl"}} {{.Label "com.countix.testpg.repo"}}')
echo "countix-testpg-reaper: removed $removed, kept $kept"
