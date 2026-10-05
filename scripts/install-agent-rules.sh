#!/usr/bin/env bash
#
# Install docs/agent-operating-rules.md as the global instructions of every
# credential profile (and the home-dir login), so each agent on this box gets
# the WaveCode rules whatever repository it works in:
#   Claude Code reads $CLAUDE_CONFIG_DIR/CLAUDE.md, Codex reads $CODEX_HOME/AGENTS.md.
# Grok has no equivalent global file; the rules reach grok agents through the
# project's AGENTS.md and the room templates.
#
# Run as the service user from the WaveCode install dir:  bash scripts/install-agent-rules.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RULES="${HERE}/docs/agent-operating-rules.md"
CFG="${HERE}/config.yaml"
[ -f "${RULES}" ] || { echo "missing ${RULES}"; exit 1; }

ROOT="$(awk '/^profiles_root:/{print $2}' "${CFG}")"
PROFILES="$(awk '/^profiles:/{f=1;next} f&&/^  [a-zA-Z0-9_-]+:/{gsub(":","",$1);print $1} f&&/^[^ ]/{f=0}' "${CFG}")"

MARKER='installed by WaveCode (scripts/install-agent-rules.sh)'
install_rules() { # dir file
  mkdir -p "$1"
  if [ -f "$1/$2" ] && ! grep -q "${MARKER}" "$1/$2"; then
    echo "  SKIP $1/$2 — exists and is not WaveCode's (merge docs/agent-operating-rules.md by hand)"; return
  fi
  { printf '<!-- installed by WaveCode (scripts/install-agent-rules.sh); edit docs/agent-operating-rules.md instead -->\n'; cat "${RULES}"; } > "$1/$2"
  chmod 600 "$1/$2"
  echo "  $1/$2"
}

echo "WaveCode agent rules →"
for p in ${PROFILES}; do
  install_rules "${ROOT}/${p}/claude" CLAUDE.md
  install_rules "${ROOT}/${p}/codex" AGENTS.md
done
# home-dir login (agents without a profile)
install_rules "${HOME}/.claude" CLAUDE.md
install_rules "${HOME}/.codex" AGENTS.md
echo "done — running agents pick the file up on their next session; restart them to apply now."
