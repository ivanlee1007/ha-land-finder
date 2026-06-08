#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="land591-finder.service"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
PORT_VALUE="${PORT:-5910}"
MYSQL_URL_VALUE="${MYSQL_URL:-mysql://land591:land591_local_pw@127.0.0.1:3306/land591}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SYSTEMD_USER_DIR/$SERVICE_NAME"

mkdir -p "$SYSTEMD_USER_DIR"

cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=591 Land Finder web server
Documentation=https://github.com/ivanlee1007/land591-finder-skill
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT_VALUE
Environment=MYSQL_URL=$MYSQL_URL_VALUE
ExecStart=$NPM_BIN run serve
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

npm install
npm run init-db

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

if command -v loginctl >/dev/null 2>&1; then
  if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '^Linger=no'; then
    cat <<MSG

注意：目前 systemd user linger 未啟用。若要在使用者未登入時也自動啟動，請執行：
  sudo loginctl enable-linger $USER
MSG
  fi
fi

systemctl --user --no-pager --full status "$SERVICE_NAME"
