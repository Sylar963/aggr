#!/usr/bin/env bash
# Installs Aggr as a 24/7 systemd service behind Caddy at https://aggr.localhost
# Run with: sudo bash deploy/install.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
CADDYFILE=/etc/caddy/Caddyfile
ENV_FILE=/etc/aggr/aggr.env

echo "==> Environment file ($ENV_FILE)"
mkdir -p /etc/aggr
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
DIST_SERVER_HOST=127.0.0.1
DIST_SERVER_PORT=8060
WORKSPACES_DB=/var/lib/aggr/workspaces.json
SHARE_BASE_URL=https://aggr.localhost
CORS_ORIGINS=https://aggr.localhost
IP_SALT=$(openssl rand -hex 32)
WORKSPACE_DELETE_TOKEN=$(openssl rand -hex 32)
ENV
  echo "    created with fresh random secrets"
else
  echo "    already exists, keeping it"
fi
chmod 600 "$ENV_FILE"

echo "==> systemd service"
install -m 644 "$DIR/aggr.service" /etc/systemd/system/aggr.service
systemctl daemon-reload
systemctl enable aggr
systemctl restart aggr
for i in $(seq 1 30); do
  curl -sf -o /dev/null http://127.0.0.1:8060/ && break
  sleep 1
done
curl -sf -o /dev/null http://127.0.0.1:8060/ || { echo "aggr did not start:"; journalctl -u aggr -n 30 --no-pager; exit 1; }
echo "    aggr running on 127.0.0.1:8060"

echo "==> Caddy"
if grep -q "aggr.localhost" "$CADDYFILE"; then
  echo "    aggr.localhost already in $CADDYFILE, leaving it"
else
  BACKUP="$CADDYFILE.bak.$(date +%s)"
  cp "$CADDYFILE" "$BACKUP"
  cat "$DIR/aggr.caddy" >> "$CADDYFILE"
  if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    cp "$BACKUP" "$CADDYFILE"
    echo "    Caddyfile invalid after change, restored $BACKUP"
    exit 1
  fi
  echo "    added site block (backup: $BACKUP)"
fi
systemctl reload caddy

echo "==> /etc/hosts"
grep -qE "^\s*127\.0\.0\.1\s+.*\baggr\.localhost\b" /etc/hosts || echo "127.0.0.1 aggr.localhost" >> /etc/hosts

echo "==> Trust Caddy's local certificate authority"
ROOT_CRT=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
for i in $(seq 1 15); do
  [ -f "$ROOT_CRT" ] && break
  curl -sk -o /dev/null https://aggr.localhost/ || true
  sleep 1
done
if [ -f "$ROOT_CRT" ]; then
  install -m 644 "$ROOT_CRT" /usr/local/share/ca-certificates/caddy-local-root.crt
  update-ca-certificates >/dev/null
  echo "    installed into system trust store"
else
  echo "    WARNING: $ROOT_CRT not found yet, re-run this script in a minute"
fi

echo "==> Check"
curl -s -o /dev/null -w "    https://aggr.localhost -> HTTP %{http_code}\n" https://aggr.localhost/
echo "Done. Open https://aggr.localhost"
