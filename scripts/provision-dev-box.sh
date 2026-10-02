#!/usr/bin/env bash
#
# Provision a dedicated WaveCode development box (multi-user, shared agents,
# one CLI subscription per credential profile). Run as root on Ubuntu 24.04+.
#
#   WAVE_HOSTNAME=countix-dev ADMIN_USER=denis \
#   WAVE_PROFILES="denis dev1 dev2 dev3" \
#   WAVE_USERS="denis:admin:denis dev1:developer:dev1 dev2:developer:dev2" \
#   bash provision-dev-box.sh
#
# Layout: ADMIN_USER has sudo; `wave` runs the daemon + every tmux agent +
# all credential profiles (no sudo, never production secrets); members of
# group `wavedev` may `sudo -iu wave` without a password. Idempotent.
set -euo pipefail

WAVE_HOSTNAME="${WAVE_HOSTNAME:-}"
ADMIN_USER="${ADMIN_USER:-}"            # sudo user; gets root's authorized_keys
WAVE_USER="${WAVE_USER:-wave}"
WAVE_HOME="/home/${WAVE_USER}"
WAVE_REPO="${WAVE_REPO:-https://github.com/dbenic/wavecode.git}"
WAVE_PORT="${WAVE_PORT:-3777}"
WAVE_PROFILES="${WAVE_PROFILES:-}"      # credential profiles (config `profiles:`)
WAVE_USERS="${WAVE_USERS:-}"            # "name:role[:profile] …" — tokens printed once
NODE_MAJOR="${NODE_MAJOR:-22}"
OPS_NOTE="${WAVE_HOME}/wavecode-ops.md"

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

# ───────────────────────── 1. base system ─────────────────────────
if [ -n "${WAVE_HOSTNAME}" ] && [ "$(hostname)" != "${WAVE_HOSTNAME}" ]; then
  log "Hostname → ${WAVE_HOSTNAME}"
  hostnamectl set-hostname "${WAVE_HOSTNAME}"
  grep -q "${WAVE_HOSTNAME}" /etc/hosts || echo "127.0.1.1 ${WAVE_HOSTNAME}" >> /etc/hosts
fi
timedatectl set-timezone UTC >/dev/null 2>&1 || true

log "Packages (update + upgrade + tooling)"
apt-get update -qq
apt-get upgrade -y -qq >/dev/null
apt-get install -y -qq git tmux curl ca-certificates gnupg ufw fail2ban unattended-upgrades chrony \
  mdadm smartmontools jq gh openssl build-essential python3 rsync htop sqlite3 >/dev/null

log "Unattended security upgrades + journald cap"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CFG'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CFG
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=2G\n' > /etc/systemd/journald.conf.d/cap.conf
systemctl restart systemd-journald

log "Node ${NODE_MAJOR} (system-wide, NodeSource)"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" != "${NODE_MAJOR}" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

log "Docker (Wavepulse API tests use testcontainers)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  . /etc/os-release
  # Docker publishes per-codename repos; fall back to the newest LTS codename on a release they have not packaged yet.
  CODENAME="${VERSION_CODENAME}"
  curl -fsI "https://download.docker.com/linux/ubuntu/dists/${CODENAME}/Release" >/dev/null 2>&1 || CODENAME=noble
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null
docker --version

# ───────────────────────── 2. people + service user ─────────────────────────
log "Service user ${WAVE_USER} and group wavedev"
getent group wavedev >/dev/null || groupadd wavedev
id "${WAVE_USER}" >/dev/null 2>&1 || adduser --disabled-password --gecos "WaveCode service" "${WAVE_USER}"
usermod -aG docker "${WAVE_USER}"
install -d -o "${WAVE_USER}" -g "${WAVE_USER}" -m 0700 "${WAVE_HOME}/.ssh" "${WAVE_HOME}/profiles" "${WAVE_HOME}/repos" "${WAVE_HOME}/projects" "${WAVE_HOME}/.local/bin"
loginctl enable-linger "${WAVE_USER}" >/dev/null 2>&1 || true
cat > /etc/sudoers.d/wavedev <<CFG
# Developers may become the service user (profile logins, tmux attach) — nothing else.
%wavedev ALL=(${WAVE_USER}) NOPASSWD: ALL
CFG
chmod 0440 /etc/sudoers.d/wavedev
visudo -cf /etc/sudoers.d/wavedev >/dev/null

if [ -n "${ADMIN_USER}" ]; then
  log "Admin user ${ADMIN_USER} (sudo, docker, wavedev; root's SSH key)"
  id "${ADMIN_USER}" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "${ADMIN_USER}"
  usermod -aG sudo,docker,wavedev "${ADMIN_USER}"
  install -d -o "${ADMIN_USER}" -g "${ADMIN_USER}" -m 0700 "/home/${ADMIN_USER}/.ssh"
  if [ -s /root/.ssh/authorized_keys ]; then
    cat /root/.ssh/authorized_keys >> "/home/${ADMIN_USER}/.ssh/authorized_keys"
    sort -u -o "/home/${ADMIN_USER}/.ssh/authorized_keys" "/home/${ADMIN_USER}/.ssh/authorized_keys"
    chown "${ADMIN_USER}:${ADMIN_USER}" "/home/${ADMIN_USER}/.ssh/authorized_keys"; chmod 600 "/home/${ADMIN_USER}/.ssh/authorized_keys"
  fi
  echo "${ADMIN_USER} ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/90-${ADMIN_USER}; chmod 0440 /etc/sudoers.d/90-${ADMIN_USER}
fi

log "SSH: keys only, no passwords (root login is disabled separately, after the admin login is verified)"
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'CFG'
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 4
ClientAliveInterval 300
ClientAliveCountMax 2
CFG
sshd -t && (systemctl reload ssh 2>/dev/null || systemctl restart ssh.socket 2>/dev/null || systemctl restart ssh)  # 24.04+: socket-activated

log "fail2ban (sshd jail)"
cat > /etc/fail2ban/jail.local <<'CFG'
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
[sshd]
enabled = true
CFG
systemctl enable --now fail2ban >/dev/null; systemctl restart fail2ban

log "Firewall: SSH + Tailscale only (WaveCode's port is never public)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw --force enable >/dev/null

log "Disk health: mdadm + smartd monitoring"
grep -q "^MAILADDR" /etc/mdadm/mdadm.conf 2>/dev/null || echo "MAILADDR root" >> /etc/mdadm/mdadm.conf
systemctl enable --now smartd >/dev/null 2>&1 || true

# ───────────────────────── 3. CLIs + WaveCode ─────────────────────────
log "Agent CLIs (latest, system-wide; logins happen per profile)"
npm install -g --no-fund --no-audit @anthropic-ai/claude-code@latest @openai/codex@latest >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code@latest @openai/codex@latest
echo "claude $(claude --version 2>/dev/null | head -1) | $(codex --version 2>/dev/null | head -1) | grok: $(command -v grok || echo 'not installed — see ops note')"

log "WaveCode: clone or update, build"
su - "${WAVE_USER}" -c "
  set -e
  if [ -d ~/wavecode/.git ]; then git -C ~/wavecode pull -q --ff-only; else git clone -q ${WAVE_REPO} ~/wavecode; fi
  cd ~/wavecode && npm install --no-audit --no-fund >/dev/null 2>&1 && npm --prefix src/ui install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1
  # The CLI resolves config.yaml next to dist/ and wavecode.db in the cwd: always run from the install dir.
  printf '#!/usr/bin/env bash\ncd %s/wavecode && exec node dist/cli/index.js \"\$@\"\n' '${WAVE_HOME}' > ~/.local/bin/wavecode
  chmod +x ~/.local/bin/wavecode
  git -C ~/wavecode log --oneline -1
"
# Developers call `wave-login <runtime>` as themselves; the profile = their Linux username.
cat > /usr/local/bin/wave-login <<CFG
#!/usr/bin/env bash
# Log *your* subscription in for one runtime: wave-login claude-code | codex | grok  [profile]
set -e
runtime="\${1:?usage: wave-login <runtime> [profile]}"; profile="\${2:-\$USER}"
exec sudo -iu ${WAVE_USER} ${WAVE_HOME}/.local/bin/wavecode profile login "\$profile" "\$runtime"
CFG
chmod 0755 /usr/local/bin/wave-login
ln -sf "${WAVE_HOME}/.local/bin/wavecode" /usr/local/bin/wavecode-admin 2>/dev/null || true

CFG_FILE="${WAVE_HOME}/wavecode/config.yaml"
if [ ! -f "${CFG_FILE}" ]; then
  log "config.yaml (token auth; one profile per developer; review loop on)"
  TOKEN="$(openssl rand -hex 24)"
  PROFILE_LINES=""
  for p in ${WAVE_PROFILES}; do PROFILE_LINES+="  ${p}: {}"$'\n'; done
  cat > "${CFG_FILE}" <<CFG
server:
  port: ${WAVE_PORT}
  host: 127.0.0.1          # tailscale serve fronts this with HTTPS; never bind publicly

paths:
  projects_root: ${WAVE_HOME}/projects
  worktrees_root: ${WAVE_HOME}/.wavecode-data/worktrees
  transcripts_root: ${WAVE_HOME}/.wavecode-data/transcripts
  rooms_root: ${WAVE_HOME}/.wavecode-data/rooms
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
    env: { CLAUDE_CONFIG_DIR: '{profile_dir}/claude', GIT_CONFIG_GLOBAL: '{profile_dir}/gitconfig' }
    login_command: claude /login
    credential_files: ['{profile_dir}/claude/.credentials.json']
  codex:
    command: codex -a never -s workspace-write
    idle_pattern: '^>\\s*\$'
    model_flag: -m
    effort_flag: -c model_reasoning_effort=
    env: { CODEX_HOME: '{profile_dir}/codex', GIT_CONFIG_GLOBAL: '{profile_dir}/gitconfig' }
    login_command: codex login
    credential_files: ['{profile_dir}/codex/auth.json']
  grok:
    command: grok --always-approve
    idle_pattern: '^>\\s*\$'
    model_flag: --model
    env: { HOME: '{profile_dir}/grok-home', GIT_CONFIG_GLOBAL: '{profile_dir}/gitconfig' }
    login_command: grok
    credential_files: ['{profile_dir}/grok-home/.grok/user-settings.json', '{profile_dir}/grok-home/.grok/auth.json']

auth:
  method: token
  fallback_token: ${TOKEN}

# One CLI subscription per profile (spec §5). Log in: wave-login <runtime> [profile]
profiles_root: ${WAVE_HOME}/profiles
profiles:
${PROFILE_LINES}
review:
  auto_review: true
  default_reviewer: reviewer
  self_review: false
  max_fix_loops: 2
  require_pass_to_promote: true
  gate_dependents_on_approval: false

artifacts:
  storage: ${WAVE_HOME}/.wavecode-data/artifacts
  retention_days: 30
CFG
  chown "${WAVE_USER}:${WAVE_USER}" "${CFG_FILE}"; chmod 600 "${CFG_FILE}"
fi

log "Profiles: dirs + git identity placeholder per profile"
for p in ${WAVE_PROFILES}; do
  d="${WAVE_HOME}/profiles/${p}"
  install -d -o "${WAVE_USER}" -g "${WAVE_USER}" -m 0700 "$d" "$d/claude" "$d/codex" "$d/grok-home"
  [ -f "$d/gitconfig" ] || printf '[user]\n\tname = %s\n\temail = %s@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n' "$p" "$p" > "$d/gitconfig"
  chown "${WAVE_USER}:${WAVE_USER}" "$d/gitconfig"; chmod 600 "$d/gitconfig"
done

log "systemd unit"
cat > /etc/systemd/system/wavecode.service <<CFG
[Unit]
Description=WaveCode Orchestrator Daemon
After=network-online.target tailscaled.service docker.service
Wants=network-online.target

[Service]
Type=simple
User=${WAVE_USER}
WorkingDirectory=${WAVE_HOME}/wavecode
ExecStart=/usr/bin/node dist/cli/index.js server start --foreground
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${WAVE_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=wavecode
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
CFG
systemctl daemon-reload
systemctl enable wavecode >/dev/null
systemctl restart wavecode
sleep 4; systemctl is-active wavecode

log "Nightly backup: SQLite db + rooms → /var/backups/wavecode (14 days; profiles excluded — they hold tokens)"
cat > /etc/cron.daily/wavecode-backup <<CFG
#!/usr/bin/env bash
set -e
dest=/var/backups/wavecode/\$(date +%F); mkdir -p "\$dest"
sqlite3 ${WAVE_HOME}/wavecode/wavecode.db ".backup '\$dest/wavecode.db'"
[ -d ${WAVE_HOME}/.wavecode-data/rooms ] && tar czf "\$dest/rooms.tgz" -C ${WAVE_HOME}/.wavecode-data rooms
cp ${CFG_FILE} "\$dest/config.yaml"; chmod -R go-rwx /var/backups/wavecode
find /var/backups/wavecode -maxdepth 1 -mindepth 1 -type d -mtime +14 -exec rm -rf {} +
CFG
chmod 0755 /etc/cron.daily/wavecode-backup

log "Tailscale"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
systemctl enable --now tailscaled >/dev/null 2>&1 || true

# ───────────────────────── 4. WaveCode users ─────────────────────────
if [ -n "${WAVE_USERS}" ]; then
  log "WaveCode users (tokens recorded ONCE in ${OPS_NOTE})"
  touch "${OPS_NOTE}"; chown "${WAVE_USER}:${WAVE_USER}" "${OPS_NOTE}"; chmod 600 "${OPS_NOTE}"
  for spec in ${WAVE_USERS}; do
    IFS=: read -r name role profile <<< "${spec}"
    out="$(su - "${WAVE_USER}" -c "~/.local/bin/wavecode user add ${name} --role ${role} --profile ${profile:-$name}" 2>&1)" || true
    echo "${out}" | grep -qi "token" && printf '\n## user %s (%s, profile %s)\n%s\n' "${name}" "${role}" "${profile:-$name}" "${out}" >> "${OPS_NOTE}" || echo "  ${name}: ${out}" | head -2
  done
fi

cat <<EOT

Done on $(hostname). Next:
  1. tailscale up   → approve the link; then:  tailscale serve --bg ${WAVE_PORT}   (HTTPS on the tailnet)
  2. As a developer: ssh in, run  wave-login claude-code | codex | grok  (your own subscription, once per CLI)
  3. Admin token + user tokens: ${OPS_NOTE} (readable by ${WAVE_USER} only)
  4. Verify you can ssh as ${ADMIN_USER:-<admin>} and sudo, THEN disable root login:
       echo 'PermitRootLogin no' > /etc/ssh/sshd_config.d/20-no-root.conf && (systemctl reload ssh || systemctl restart ssh.socket)
EOT
