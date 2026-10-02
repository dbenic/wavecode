#!/usr/bin/env bash
#
# Provision a dedicated WaveCode development box: one service user running the
# daemon and every agent in tmux, per-developer credential profiles (one CLI
# subscription each), Tailscale-only access, no production secrets on the box.
#
# Run as root on a fresh Ubuntu 24.04:
#   WAVE_USER=wave WAVE_USERS="denis:admin ana:developer marko:developer" \
#   WAVE_PROJECTS="wavepulse=git@github.com:dbenic/Wavepulse.git" \
#   bash provision-dev-box.sh
#
# Idempotent: re-running updates WaveCode and leaves users, profiles and data alone.
set -euo pipefail

WAVE_USER="${WAVE_USER:-wave}"
WAVE_HOME="/home/${WAVE_USER}"
WAVE_REPO="${WAVE_REPO:-https://github.com/dbenic/wavecode.git}"
WAVE_PORT="${WAVE_PORT:-3777}"
WAVE_USERS="${WAVE_USERS:-}"          # "name:role name:role …" — created once, tokens printed once
WAVE_PROJECTS="${WAVE_PROJECTS:-}"    # "name=git-url …" — cloned under ~/repos for worktrees
NODE_MAJOR="${NODE_MAJOR:-22}"

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

log "System packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git tmux curl ca-certificates gnupg ufw gh jq openssl build-essential python3 >/dev/null

log "Service user ${WAVE_USER} (no sudo, no production secrets)"
id "${WAVE_USER}" >/dev/null 2>&1 || adduser --disabled-password --gecos "WaveCode service" "${WAVE_USER}"
install -d -o "${WAVE_USER}" -g "${WAVE_USER}" -m 0700 "${WAVE_HOME}/.ssh" "${WAVE_HOME}/profiles" "${WAVE_HOME}/repos" "${WAVE_HOME}/projects"

log "Node ${NODE_MAJOR} via nvm for ${WAVE_USER}"
su - "${WAVE_USER}" -c "
  set -e
  [ -d ~/.nvm ] || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null
  export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh
  nvm install ${NODE_MAJOR} --no-progress >/dev/null
  nvm alias default ${NODE_MAJOR} >/dev/null
  node --version
"
NODE_BIN="$(su - "${WAVE_USER}" -c 'export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh; dirname $(command -v node)')"

log "Agent CLIs (installed for ${WAVE_USER}; each developer logs in through their own profile later)"
su - "${WAVE_USER}" -c "
  export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh
  export PATH=\$HOME/.local/bin:\$PATH
  command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code >/dev/null
  command -v codex  >/dev/null || npm install -g @openai/codex >/dev/null
  echo \"claude: \$(command -v claude || echo MISSING)  codex: \$(command -v codex || echo MISSING)  grok: \$(command -v grok || echo 'MISSING (install per vendor instructions)')\"
"

log "WaveCode: clone or update, build"
su - "${WAVE_USER}" -c "
  set -e
  export NVM_DIR=\$HOME/.nvm; . \$NVM_DIR/nvm.sh
  if [ -d ~/wavecode/.git ]; then git -C ~/wavecode pull -q --ff-only; else git clone -q ${WAVE_REPO} ~/wavecode; fi
  cd ~/wavecode && npm install --no-audit --no-fund >/dev/null && npm --prefix src/ui install --no-audit --no-fund >/dev/null && npm run build >/dev/null
  mkdir -p ~/.local/bin
  # The CLI resolves config.yaml next to dist/ and wavecode.db in the cwd: always run from the install dir.
  printf '#!/usr/bin/env bash\ncd %s/wavecode && exec %s/node dist/cli/index.js \"\$@\"\n' '${WAVE_HOME}' '${NODE_BIN}' > ~/.local/bin/wavecode
  chmod +x ~/.local/bin/wavecode
"

log "Project clones for worktrees"
for spec in ${WAVE_PROJECTS}; do
  name="${spec%%=*}"; url="${spec#*=}"
  su - "${WAVE_USER}" -c "[ -d ~/repos/${name}/.git ] || git clone -q '${url}' ~/repos/${name}" || echo "  (clone of ${name} failed — add the deploy key first, then re-run)"
done

CFG="${WAVE_HOME}/wavecode/config.yaml"
if [ ! -f "${CFG}" ]; then
  log "config.yaml (token auth; profiles; review loop on; bind to Tailscale later)"
  TOKEN="$(openssl rand -hex 24)"
  PROFILE_LINES=""
  for spec in ${WAVE_USERS}; do PROFILE_LINES+="  ${spec%%:*}: {}"$'\n'; done
  cat > "${CFG}" <<EOF
server:
  port: ${WAVE_PORT}
  host: 0.0.0.0            # switch to the Tailscale IP once tailscale is up

paths:
  projects_root: ${WAVE_HOME}/projects
  worktrees_root: ${WAVE_HOME}/.wavecode-data/worktrees
  transcripts_root: ${WAVE_HOME}/.wavecode-data/transcripts
  teams_root: ${WAVE_HOME}/wavecode/teams
  guides_root: ${WAVE_HOME}/wavecode/guides
  templates_root: ${WAVE_HOME}/wavecode/templates

autonomy:
  auto_dispatch: true
  auto_restart: true
  hang_timeout_min: 10
  max_task_retries: 2
  verify_completion: false

runtimes:
  claude-code:
    command: claude --permission-mode bypassPermissions
    idle_pattern: '\\\$\\s*\$'
    model_flag: --model
  codex:
    command: codex -a never -s workspace-write
    idle_pattern: '^>\\s*\$'
    model_flag: -m
    effort_flag: -c model_reasoning_effort=
  grok:
    command: grok --always-approve
    idle_pattern: '^>\\s*\$'
    model_flag: --model

auth:
  method: token
  fallback_token: ${TOKEN}

# One CLI subscription per developer (spec §5): each person logs their CLIs in
# with `wavecode profile login <name> <runtime>`; their agents and seat run on it.
profiles_root: ${WAVE_HOME}/profiles
profiles:
${PROFILE_LINES}
review:
  auto_review: true
  default_reviewer: codex
  self_review: false
  max_fix_loops: 2
  require_pass_to_promote: true
  gate_dependents_on_approval: false

artifacts:
  storage: ${WAVE_HOME}/.wavecode-data/artifacts
  retention_days: 30
EOF
  chown "${WAVE_USER}:${WAVE_USER}" "${CFG}"; chmod 600 "${CFG}"
  echo "  fallback (admin) token written to ${CFG}"
fi

log "systemd unit"
cat > /etc/systemd/system/wavecode.service <<EOF
[Unit]
Description=WaveCode Orchestrator Daemon
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=${WAVE_USER}
WorkingDirectory=${WAVE_HOME}/wavecode
ExecStart=${NODE_BIN}/node dist/cli/index.js server start --foreground
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${WAVE_HOME}/.local/bin:${NODE_BIN}:/usr/local/bin:/usr/bin:/bin
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wavecode
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now wavecode >/dev/null
systemctl restart wavecode
sleep 4 && systemctl is-active wavecode

log "Tailscale (claim the device, then bind server.host to its 100.x address and lock the firewall)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
systemctl enable --now tailscaled >/dev/null 2>&1 || true

log "Firewall: SSH + Tailscale only (WaveCode's port is NOT public)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw --force enable >/dev/null
ufw status | sed 's/^/  /'

if [ -n "${WAVE_USERS}" ]; then
  log "Users (tokens are shown ONCE — hand each to its person privately)"
  for spec in ${WAVE_USERS}; do
    name="${spec%%:*}"; role="${spec#*:}"
    su - "${WAVE_USER}" -c "export PATH=\$HOME/.local/bin:\$PATH; wavecode user add ${name} --role ${role} 2>&1 | sed 's/^/  /'" || true
  done
fi

cat <<EOF

Done. Next, in order:
  1. tailscale up            → claim the device; then set server.host to its 100.x IP in ${CFG} and: systemctl restart wavecode
  2. Each developer, once per CLI:  wavecode profile login <name> claude-code | codex | grok   (their own Pro subscription)
  3. Add a GitHub deploy key per profile for pushes to lane branches; never a production .env on this box.
  4. Open http://<tailscale-ip>:${WAVE_PORT}, log in with your token, create your seat (Settings → My seat).
EOF
