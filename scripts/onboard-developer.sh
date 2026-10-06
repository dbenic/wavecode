#!/usr/bin/env bash
#
# Onboard a developer on a WaveCode dev box, end to end:
#   Linux login (group wavedev, no sudo) · credential profile · WaveCode user + token · agent rules.
#
#   sudo bash scripts/onboard-developer.sh <name> <ssh-public-key-file|-> [admin|developer|observer]
#   ("-" = no SSH key yet; the login is created locked and a key can be added later with
#    sudo bash scripts/onboard-developer.sh <name> <key-file> — re-running only adds the key)
#
# Safe to re-run. Restarts the daemon only when no run is in flight. Prints the
# developer's hand-over text; their token is appended to the ops note (never printed).
set -euo pipefail
NAME="${1:?usage: onboard-developer.sh <name> <ssh-pubkey-file> [role]}"
KEYFILE="${2:?usage: onboard-developer.sh <name> <ssh-pubkey-file> [role]}"
ROLE="${3:-developer}"
WAVE_USER="${WAVE_USER:-wave}"
WAVE_HOME="/home/${WAVE_USER}"
CFG="${WAVE_HOME}/wavecode/config.yaml"
OPS="${WAVE_HOME}/wavecode-ops.md"

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
[[ "${NAME}" =~ ^[a-z][a-z0-9_-]{1,31}$ ]] || { echo "name must be lowercase letters/digits/-/_"; exit 1; }
if [ "${KEYFILE}" != "-" ]; then
  [ -s "${KEYFILE}" ] || { echo "missing key file ${KEYFILE}"; exit 1; }
  grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com) ' "${KEYFILE}" || { echo "not an SSH public key: ${KEYFILE}"; exit 1; }
fi
case "${ROLE}" in admin|developer|observer) ;; *) echo "role must be admin|developer|observer"; exit 1;; esac

echo "▸ Linux login ${NAME} (group wavedev: may 'sudo -iu ${WAVE_USER}' for logins and tmux; no sudo otherwise)"
id "${NAME}" >/dev/null 2>&1 || adduser --disabled-password --gecos "WaveCode developer" "${NAME}"
usermod -aG wavedev "${NAME}"
install -d -o "${NAME}" -g "${NAME}" -m 0700 "/home/${NAME}/.ssh"
touch "/home/${NAME}/.ssh/authorized_keys"
if [ "${KEYFILE}" != "-" ]; then
  grep -qxF "$(cat "${KEYFILE}")" "/home/${NAME}/.ssh/authorized_keys" || cat "${KEYFILE}" >> "/home/${NAME}/.ssh/authorized_keys"
else
  echo "  (no SSH key yet — add one later by re-running with the key file)"
fi
chown "${NAME}:${NAME}" "/home/${NAME}/.ssh/authorized_keys"; chmod 600 "/home/${NAME}/.ssh/authorized_keys"

echo "▸ Credential profile ${NAME} (one subscription per CLI; logs in with wave-login)"
install -d -o "${WAVE_USER}" -g "${WAVE_USER}" -m 0700 "${WAVE_HOME}/profiles/${NAME}" "${WAVE_HOME}/profiles/${NAME}/claude" "${WAVE_HOME}/profiles/${NAME}/codex" "${WAVE_HOME}/profiles/${NAME}/grok-home"
GC="${WAVE_HOME}/profiles/${NAME}/gitconfig"
[ -f "${GC}" ] || { printf '[user]\n\tname = %s\n\temail = %s@users.noreply.github.com\n[init]\n\tdefaultBranch = main\n' "${NAME}" "${NAME}" > "${GC}"; chown "${WAVE_USER}:${WAVE_USER}" "${GC}"; chmod 600 "${GC}"; }
RESTART=0
if ! grep -qE "^  ${NAME}: " "${CFG}"; then
  # insert under `profiles:`; config is the daemon's — it reloads on restart only
  sed -i "s|^profiles:\$|profiles:\n  ${NAME}: {}|" "${CFG}"
  RESTART=1
fi

if [ "${RESTART}" -eq 1 ]; then
  RUNNING=$(sqlite3 "${WAVE_HOME}/wavecode/wavecode.db" "select count(*) from runs where status='running'" 2>/dev/null || echo 0)
  if [ "${RUNNING}" = "0" ]; then
    echo "▸ Restarting wavecode (new profile in config; no run in flight)"
    systemctl restart wavecode; sleep 3; systemctl is-active wavecode >/dev/null
  else
    echo "▸ NOT restarting wavecode: ${RUNNING} run(s) in flight — restart later: sudo systemctl restart wavecode"
  fi
fi

echo "▸ WaveCode user ${NAME} (${ROLE}, profile ${NAME}); token → ${OPS}"
if su - "${WAVE_USER}" -c "cd ~/wavecode && sqlite3 wavecode.db \"select 1 from users where name='${NAME}'\"" | grep -q 1; then
  OUT="exists (token unchanged; see ${OPS})"
else
  OUT=$(su - "${WAVE_USER}" -c "cd ~/wavecode && ~/.local/bin/wavecode user add ${NAME} --role ${ROLE} --profile ${NAME}" 2>&1) || true
fi
if echo "${OUT}" | grep -qi "token"; then
  printf '\n## user %s (%s, profile %s) — onboarded %s\n%s\n' "${NAME}" "${ROLE}" "${NAME}" "$(date -u +%F)" "${OUT}" >> "${OPS}"
  echo "  token recorded"
else
  echo "  ${OUT}" | head -n 1
fi

echo "▸ Agent rules into the new profile"
su - "${WAVE_USER}" -c "bash ~/wavecode/scripts/install-agent-rules.sh" >/dev/null

TS_HOST="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
cat <<EOT

Done. Hand this to ${NAME}:
  1. SSH:  ssh ${NAME}@$(hostname -I | awk '{print $1}')   (tailnet: ${TS_HOST:-<tailscale name>})
  2. Log your own subscriptions in, once per CLI you will use:
       wave-login claude-code      wave-login codex      wave-login grok
  3. Open http://${TS_HOST:-countix-dev}:3777 and paste your WaveCode token (the admin hands it to you from the ops note).
  4. Settings → My seat → Create. Then spawn your agents from the Dashboard (they run on your subscription).
EOT
