#!/usr/bin/env bash
set -euo pipefail

# Installer for the FreedomHub mirror bot.
# Tested on Debian/Ubuntu. Run as root.
#
#   ./install.sh                     # install deps + systemd service
#   ./install.sh --no-systemd        # install deps only (run bot manually)

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD=1
if [[ "${1:-}" == "--no-systemd" ]]; then
  SYSTEMD=0
fi

echo "==> Installing system dependencies"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    nodejs npm python3 python3-pip sqlite3 curl
elif command -v yum >/dev/null 2>&1; then
  yum install -y nodejs npm python3 python3-pip sqlite curl
fi

echo "==> Installing npm dependencies"
npm install --prefix "$DIR"

echo "==> Installing python dependencies"
pip3 install --break-system-packages requests beautifulsoup4 2>/dev/null \
  || pip3 install requests beautifulsoup4

if [[ ! -f "$DIR/config.json" ]]; then
  echo "==> Creating config.json from example (EDIT IT!)"
  cp "$DIR/config.example.json" "$DIR/config.json"
  echo "    -> please fill in your tokens/IDs in $DIR/config.json"
fi

if [[ $SYSTEMD -eq 1 ]]; then
  echo "==> Installing systemd service"
  cp "$DIR/freedns-unblocker.service" /etc/systemd/system/freedns-unblocker.service
  systemctl daemon-reload
  systemctl enable freedns-unblocker.service
  systemctl restart freedns-unblocker.service
  echo "==> Started. Logs: journalctl -u freedns-unblocker -f"
else
  echo "==> Ready. Run: node $DIR/botv14/bot.js"
fi

echo "==> Done."