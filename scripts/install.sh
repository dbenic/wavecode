#!/usr/bin/env bash
#
# WaveCode Installer
# Run from a local clone, or pipe from a published repo while setting WAVECODE_REPO.
#
# Installs WaveCode to ~/.wavecode and starts the server.
# Works on macOS and Linux. Requires Node.js 22+ and tmux.
#
set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────
WAVECODE_HOME="${WAVECODE_HOME:-$HOME/.wavecode}"
WAVECODE_REPO="${WAVECODE_REPO:-}"
WAVECODE_PORT="${WAVECODE_PORT:-3777}"
NODE_MIN_VERSION=22
GENERATED_ACCESS_TOKEN=""

# ─── Colors ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()  { echo -e "${CYAN}▸${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

has_local_source() {
  local dir="$1"
  [ -f "$dir/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"wavecode"' "$dir/package.json" 2>/dev/null
}

sync_local_source() {
  local src="$1"
  local dest="$2"

  if ! command -v rsync &>/dev/null; then
    fail "rsync is required when installing from a local source checkout."
  fi

  mkdir -p "$dest"
  rsync -a \
    --exclude node_modules \
    --exclude .git \
    --exclude dist \
    --exclude src/ui/dist \
    --exclude wavecode.db \
    --exclude '*.db-wal' \
    --exclude '*.db-shm' \
    --exclude .wavecode-data \
    --exclude config.yaml \
    --exclude '*.tgz' \
    "$src"/ "$dest"/
}

# ─── Banner ──────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}"
cat << 'BANNER'
 ██╗    ██╗ █████╗ ██╗   ██╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗
 ██║    ██║██╔══██╗██║   ██║██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██║ █╗ ██║███████║██║   ██║█████╗  ██║     ██║   ██║██║  ██║█████╗
 ██║███╗██║██╔══██║╚██╗ ██╔╝██╔══╝  ██║     ██║   ██║██║  ██║██╔══╝
 ╚███╔███╔╝██║  ██║ ╚████╔╝ ███████╗╚██████╗╚██████╔╝██████╔╝███████╗
  ╚══╝╚══╝ ╚═╝  ╚═╝  ╚═══╝  ╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
BANNER
echo -e "${NC}"
echo -e "${DIM}  Multi-agent coding orchestration platform${NC}"
echo ""

# ─── Pre-flight checks ──────────────────────────────────────────────────
info "Checking prerequisites..."

# OS detection
OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM="linux"  ;;
  Darwin*) PLATFORM="macos"  ;;
  *)       fail "Unsupported OS: $OS. WaveCode supports Linux and macOS." ;;
esac
ok "Platform: $PLATFORM"

# Node.js
if ! command -v node &>/dev/null; then
  echo ""
  fail "Node.js not found. Install Node.js $NODE_MIN_VERSION+ first:
    ${DIM}# Using nvm (recommended):
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    nvm install 22

    # Or using Homebrew (macOS):
    brew install node@22

    # Or using apt (Ubuntu/Debian):
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs${NC}"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]; then
  fail "Node.js $NODE_MIN_VERSION+ required (found v$(node -v | sed 's/v//'))"
fi
ok "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. It should come with Node.js."
fi
ok "npm $(npm -v)"

# tmux
if ! command -v tmux &>/dev/null; then
  echo ""
  warn "tmux not found. Installing..."
  if [ "$PLATFORM" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install tmux
    else
      fail "Install tmux: brew install tmux"
    fi
  else
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq tmux
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y tmux
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm tmux
    else
      fail "Install tmux manually for your distribution"
    fi
  fi
fi
ok "tmux $(tmux -V)"

# git
if ! command -v git &>/dev/null; then
  fail "git not found. Install git first."
fi
ok "git $(git --version | cut -d' ' -f3)"

echo ""

# ─── Install ─────────────────────────────────────────────────────────────
LOCAL_SOURCE_DIR=""
if has_local_source "$PWD"; then
  LOCAL_SOURCE_DIR="$PWD"
fi

if [ -d "$WAVECODE_HOME/.git" ]; then
  info "Updating existing installation at $WAVECODE_HOME..."
  cd "$WAVECODE_HOME"
  if git remote get-url origin &>/dev/null; then
    git pull --ff-only origin main 2>/dev/null || git pull origin main
    ok "Updated from git remote"
  elif [ -n "$LOCAL_SOURCE_DIR" ]; then
    info "Refreshing from local source at $LOCAL_SOURCE_DIR..."
    sync_local_source "$LOCAL_SOURCE_DIR" "$WAVECODE_HOME"
    ok "Updated from local source"
  else
    warn "Existing installation has no git remote. Set WAVECODE_REPO or rerun this script from a local clone to refresh source."
  fi
else
  info "Installing WaveCode to $WAVECODE_HOME..."
  if [ -n "$WAVECODE_REPO" ]; then
    git clone --depth 1 "$WAVECODE_REPO" "$WAVECODE_HOME" 2>/dev/null || \
      fail "Could not clone $WAVECODE_REPO. Check the repository URL and your internet connection."
    ok "Cloned WaveCode"
  elif [ -n "$LOCAL_SOURCE_DIR" ]; then
    info "Copying from local source at $LOCAL_SOURCE_DIR..."
    sync_local_source "$LOCAL_SOURCE_DIR" "$WAVECODE_HOME"
    ok "Copied WaveCode from local source"
  else
    fail "No repository source configured. Set WAVECODE_REPO=https://github.com/<owner>/wavecode.git or run this script from a local clone."
  fi
fi

cd "$WAVECODE_HOME"

# ─── Dependencies ────────────────────────────────────────────────────────
info "Installing dependencies..."
npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts
npm rebuild better-sqlite3 2>/dev/null || true
ok "Server dependencies installed"

if [ -f "src/ui/package.json" ]; then
  npm ci --prefix src/ui 2>/dev/null || npm install --prefix src/ui
  ok "UI dependencies installed"
fi

# ─── Build ────────────────────────────────────────────────────────────────
info "Building..."
npm run build
ok "Build completed"

# ─── Config ───────────────────────────────────────────────────────────────
if [ ! -f "config.yaml" ]; then
  info "Creating default config..."
  cp config.example.yaml config.yaml

  # Auto-detect home directory for projects
  if [ "$PLATFORM" = "macos" ]; then
    PROJECTS_DIR="$HOME/Dev"
  else
    PROJECTS_DIR="$HOME/projects"
  fi

  GENERATED_ACCESS_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"

  # Patch config with sensible defaults
  WAVECODE_PROJECTS_DIR="$PROJECTS_DIR" WAVECODE_ACCESS_TOKEN="$GENERATED_ACCESS_TOKEN" node <<'NODE'
const fs = require('node:fs');

const configPath = 'config.yaml';
let text = fs.readFileSync(configPath, 'utf8');

text = text.replace(/~\/Dev\/Projects/g, process.env.WAVECODE_PROJECTS_DIR);
text = text.replace(/method:\s*tailscale/, 'method: token');
text = text.replace(/fallback_token:\s*null/, `fallback_token: ${process.env.WAVECODE_ACCESS_TOKEN}`);

fs.writeFileSync(configPath, text, { encoding: 'utf8', mode: 0o600 });
try {
  fs.chmodSync(configPath, 0o600);
} catch {
  // best-effort
}
NODE

  ok "Config created at $WAVECODE_HOME/config.yaml"
else
  ok "Existing config.yaml preserved"
  if grep -qE '^[[:space:]]*method:[[:space:]]*tailscale' config.yaml 2>/dev/null; then
    warn "config.yaml is still using auth.method: tailscale. On a normal public server, switch to token mode or keep the service behind your own VPN/private network."
  fi
fi

# ─── Data directories ────────────────────────────────────────────────────
mkdir -p .wavecode-data/{worktrees,transcripts,artifacts}
mkdir -p guides templates teams
ok "Data directories ready"

# ─── Shell integration ───────────────────────────────────────────────────
SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  SHELL_RC="$HOME/.bash_profile"
fi

# Add wavecode alias/PATH
  if [ -n "$SHELL_RC" ]; then
  if ! grep -q "WAVECODE_HOME" "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# WaveCode" >> "$SHELL_RC"
    echo "export WAVECODE_HOME=\"$WAVECODE_HOME\"" >> "$SHELL_RC"
    echo "alias wavecode='node \$WAVECODE_HOME/dist/cli/index.js'" >> "$SHELL_RC"
    echo "alias wc-start='wavecode server start --foreground'" >> "$SHELL_RC"
    ok "Added shell aliases to $(basename "$SHELL_RC")"
  else
    ok "Shell aliases already configured"
  fi
fi

# ─── Systemd (Linux only) ────────────────────────────────────────────────
if [ "$PLATFORM" = "linux" ] && command -v systemctl &>/dev/null; then
  echo ""
  info "Optional: Install as a systemd service?"
  echo -e "  ${DIM}This lets WaveCode start on boot and restart on crash.${NC}"

  # Generate service file with correct paths
  SYSTEMD_FILE="/tmp/wavecode.service"
  cat > "$SYSTEMD_FILE" << EOF
[Unit]
Description=WaveCode Orchestrator Daemon
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$WAVECODE_HOME
ExecStart=$(command -v node) dist/cli/index.js server start --foreground
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wavecode
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  if [ -t 0 ]; then
    read -rp "  Install systemd service? [y/N] " INSTALL_SYSTEMD
    if [[ "$INSTALL_SYSTEMD" =~ ^[Yy] ]]; then
      sudo cp "$SYSTEMD_FILE" /etc/systemd/system/wavecode.service
      sudo systemctl daemon-reload
      sudo systemctl enable wavecode
      ok "Systemd service installed (start with: sudo systemctl start wavecode)"
    fi
  else
    echo -e "  ${DIM}Run manually: sudo cp $SYSTEMD_FILE /etc/systemd/system/ && sudo systemctl enable wavecode${NC}"
  fi
  rm -f "$SYSTEMD_FILE"
fi

# ─── Done ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━ WaveCode installed successfully! ━━━${NC}"
echo ""
echo -e "  ${BOLD}Start the server:${NC}"
echo -e "    wavecode server start --foreground"
echo -e "    ${DIM}(If 'wavecode' is not found yet, start a new shell or run: source ~/.zshrc / source ~/.bashrc)${NC}"
echo ""
echo -e "  ${BOLD}Or in the background with tmux:${NC}"
echo -e "    wavecode server start"
echo ""
echo -e "  ${BOLD}Then open:${NC}"
echo -e "    ${CYAN}http://localhost:$WAVECODE_PORT${NC}"
echo ""
echo -e "  ${BOLD}Configure:${NC}"
echo -e "    ${DIM}$WAVECODE_HOME/config.yaml${NC}"
echo -e "    ${DIM}WaveCode only handles app-level auth. Network exposure is up to you: firewall, reverse proxy, SSH tunnel, VPN, Tailscale, etc.${NC}"
echo ""
if [ -n "$GENERATED_ACCESS_TOKEN" ]; then
  echo -e "  ${BOLD}Access token:${NC}"
  echo -e "    ${CYAN}$GENERATED_ACCESS_TOKEN${NC}"
  echo -e "    ${DIM}You will need this to unlock the UI. It is also stored in $WAVECODE_HOME/config.yaml.${NC}"
  echo ""
fi
echo -e "  ${BOLD}Add a coding agent:${NC}"
echo -e "    ${DIM}1. Start a tmux session: tmux new -s my-agent${NC}"
echo -e "    ${DIM}2. Run your CLI agent:   claude / codex / aider${NC}"
echo -e "    ${DIM}3. Adopt in WaveCode:    Dashboard → Scan → Adopt${NC}"
echo ""
echo -e "  ${DIM}Docs: $WAVECODE_HOME/README.md and $WAVECODE_HOME/docs/api.md${NC}"
echo ""
