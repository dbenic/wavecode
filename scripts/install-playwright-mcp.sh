#!/usr/bin/env bash
# Browser tests for the agents (docs/browser-tests.md): one headless Playwright MCP
# server, installed once under the service user, offered to every credential profile's
# Codex and Claude Code config. Idempotent; re-run after adding a profile.
#
#   sudo -u wave /home/wave/wavecode/scripts/install-playwright-mcp.sh            # install + wire profiles
#   sudo -u wave /home/wave/wavecode/scripts/install-playwright-mcp.sh --check    # only report
#
# Needs the Chromium system libraries first (as root, once):
#   npx -y playwright@1.64.1 install-deps chromium
set -euo pipefail

TOOLS="${PLAYWRIGHT_MCP_HOME:-$HOME/tools/playwright-mcp}"
PROFILES="${WAVECODE_PROFILES:-$HOME/profiles}"
BIN="$HOME/bin/playwright-mcp"
REPORTS="${WAVECODE_BROWSER_REPORTS:-$HOME/.wavecode-data/browser-tests}"
PW_VERSION="${PW_VERSION:-1.64.1}"
MCP_VERSION="${MCP_VERSION:-0.0.83}"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

say() { printf '%s\n' "$*"; }

if [ "$CHECK" = 0 ]; then
  mkdir -p "$TOOLS" "$HOME/bin" "$REPORTS"
  cd "$TOOLS"
  [ -f package.json ] || npm init -y >/dev/null
  npm install --no-audit --no-fund --save-exact "@playwright/mcp@$MCP_VERSION" "playwright@$PW_VERSION" >/dev/null
  PLAYWRIGHT_BROWSERS_PATH="$TOOLS/browsers" npx playwright install chromium >/dev/null
  cat > "$BIN" <<EOF
#!/usr/bin/env bash
# Headless Playwright MCP for the agents. Each agent process gets its own isolated browser
# context; screenshots and traces go under $REPORTS/<agent or pid>/.
OUT="$REPORTS/\${WAVECODE_AGENT:-\$PPID}"
mkdir -p "\$OUT"
export PLAYWRIGHT_BROWSERS_PATH="$TOOLS/browsers"
exec node "$TOOLS/node_modules/@playwright/mcp/cli.js" --headless --isolated --browser chromium \\
  --output-dir "\$OUT" --viewport-size 1280x900 --ignore-https-errors "\$@"
EOF
  chmod 755 "$BIN"
fi

status=0
for dir in "$PROFILES"/*/; do
  profile=$(basename "$dir")
  codex_cfg="$dir/codex/config.toml"
  claude_cfg="$dir/claude/.claude.json"
  if [ -f "$codex_cfg" ]; then
    if grep -q '^\[mcp_servers\.playwright\]' "$codex_cfg"; then
      say "$profile: codex has playwright"
    elif [ "$CHECK" = 1 ]; then
      say "$profile: codex MISSING playwright"; status=1
    else
      cp -p "$codex_cfg" "$codex_cfg.bak-$(date +%Y%m%d-%H%M)-playwright"
      printf '\n[mcp_servers.playwright]\ncommand = "%s"\nstartup_timeout_sec = 60\n' "$BIN" >> "$codex_cfg"
      say "$profile: codex playwright added"
    fi
  fi
  if [ -f "$claude_cfg" ]; then
    if node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(j.mcpServers&&j.mcpServers.playwright?0:1)' "$claude_cfg"; then
      say "$profile: claude has playwright"
    elif [ "$CHECK" = 1 ]; then
      say "$profile: claude MISSING playwright"; status=1
    else
      cp -p "$claude_cfg" "$claude_cfg.bak-$(date +%Y%m%d-%H%M)-playwright"
      node -e '
        const fs = require("fs"); const [file, bin] = process.argv.slice(1);
        const j = JSON.parse(fs.readFileSync(file, "utf8"));
        j.mcpServers = j.mcpServers || {};
        j.mcpServers.playwright = { type: "stdio", command: bin, args: [] };
        fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
      ' "$claude_cfg" "$BIN"
      say "$profile: claude playwright added"
    fi
  fi
done

if [ -x "$BIN" ]; then
  say "server: $BIN"
  "$BIN" --version 2>/dev/null | head -n 1 || true
else
  say "server: not installed"; status=1
fi
exit $status
