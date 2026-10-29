#!/bin/bash
# Operator install on a box (run as a sudoer from a checkout or from a copy of scripts/):
#   sudo bash scripts/install-testpg-reaper.sh
# Installs the reaper + timer and adds OOMPolicy=continue to the wavecode unit (drop-in), then reloads systemd.
# It does not restart the daemon and does not run the reaper; run it once by hand afterwards:
#   sudo systemctl start countix-testpg-reaper.service && journalctl -u countix-testpg-reaper -n 5 --no-pager
set -eu
here=$(cd "$(dirname "$0")" && pwd)
install -m 0755 "$here/countix-testpg-reaper.sh" /usr/local/sbin/countix-testpg-reaper
install -m 0644 "$here/countix-testpg-reaper.service" /etc/systemd/system/countix-testpg-reaper.service
install -m 0644 "$here/countix-testpg-reaper.timer" /etc/systemd/system/countix-testpg-reaper.timer
d=/etc/systemd/system/wavecode.service.d; mkdir -p "$d"
if ! grep -qs '^OOMPolicy=' "$d"/*.conf; then printf '[Service]\n# an OOM-killed test worker in an agent pane must not stop the daemon\nOOMPolicy=continue\n' > "$d/60-oom-policy.conf"; fi
systemctl daemon-reload
systemctl enable --now countix-testpg-reaper.timer
echo "wavecode OOMPolicy: $(systemctl show wavecode -p OOMPolicy --value); reaper timer: $(systemctl is-enabled countix-testpg-reaper.timer)"
