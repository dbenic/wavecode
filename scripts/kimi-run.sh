#!/usr/bin/env bash
# Launch Kimi Code for a WaveCode seat.
#
# Kimi asks "Trust and continue" the first time it starts in a folder and keeps the
# answer under $KIMI_CODE_HOME/workspace-trust/wd_<basename>_<sha256(path)[0:12]>.
# A spawned seat starts in a fresh worktree every time, so the dialog would eat the
# first prompt. This writes the trust record for the current directory, then execs
# the CLI with the given arguments (`--auto`, `--model …`). KIMI_CODE_HOME comes from
# the runtime's profile env; KIMI_BIN overrides the binary path.
set -euo pipefail
bin="${KIMI_BIN:-/home/wave/.kimi-code/bin/kimi}"
home="${KIMI_CODE_HOME:-$HOME/.kimi-code}"
root="$(pwd -P)"
hash="$(printf '%s' "$root" | sha256sum | cut -c1-12)"
dir="$home/workspace-trust"
file="$dir/wd_$(basename "$root")_$hash"
if [ ! -f "$file" ]; then
  mkdir -p "$dir"
  printf '{"root":"%s","trustedAt":%s}\n' "$root" "$(date +%s)000" > "$file"
fi
exec "$bin" "$@"
