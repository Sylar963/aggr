#!/usr/bin/env bash
# Installs Aggr as a 24/7 systemd service behind Caddy at https://charts.oggregator.xyz
# Run with: sudo bash deploy/install.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
CADDYFILE=/etc/caddy/Caddyfile
ENV_FILE=/etc/aggr/aggr.env
PUBLIC_HOST=charts.oggregator.xyz
PUBLIC_URL="https://$PUBLIC_HOST"

echo "==> Environment file ($ENV_FILE)"
mkdir -p /etc/aggr
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
DIST_SERVER_HOST=127.0.0.1
DIST_SERVER_PORT=8060
WORKSPACES_DB=/var/lib/aggr/workspaces.json
SHARE_BASE_URL=$PUBLIC_URL
CORS_ORIGINS=$PUBLIC_URL
IP_SALT=$(openssl rand -hex 32)
WORKSPACE_DELETE_TOKEN=$(openssl rand -hex 32)
ENV
  echo "    created with fresh random secrets"
else
  echo "    already exists, keeping secrets"
fi
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}
set_env DIST_SERVER_HOST 127.0.0.1
set_env SHARE_BASE_URL "$PUBLIC_URL"
set_env CORS_ORIGINS "$PUBLIC_URL"
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
BACKUP="$CADDYFILE.bak.$(date +%s)"
cp "$CADDYFILE" "$BACKUP"
TMP="$(mktemp)"
# Remove the old local-only aggr.localhost block and any previous managed block
awk '
  /^# Aggr charts - local only/ { skip = 1; next }
  skip == 1 && /^aggr\.localhost \{/ { skip = 2; next }
  skip == 2 { if ($0 ~ /^}/) skip = 0; next }
  skip == 1 { skip = 0 }
  /^# BEGIN aggr/ { inblock = 1; next }
  inblock { if ($0 ~ /^# END aggr/) inblock = 0; next }
  { lines[n++] = $0 }
  END {
    while (n > 0 && lines[n - 1] ~ /^[ \t]*$/) n--
    for (i = 0; i < n; i++) print lines[i]
    print ""
  }
' "$CADDYFILE" > "$TMP"
cat "$DIR/aggr.caddy" >> "$TMP"
if ! caddy validate --config "$TMP" --adapter caddyfile >/dev/null 2>&1; then
  rm -f "$TMP"
  echo "    new Caddyfile is invalid, nothing changed"
  caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | tail -3
  exit 1
fi
cat "$TMP" > "$CADDYFILE"
rm -f "$TMP"
systemctl reload caddy
echo "    $PUBLIC_HOST -> 127.0.0.1:8060 (backup: $BACKUP)"

echo "==> Check"
curl -s -o /dev/null -w "    local server -> HTTP %{http_code}\n" http://127.0.0.1:8060/
DNS_IP="$(getent ahostsv4 "$PUBLIC_HOST" | awk '{print $1; exit}')"
if [ -n "$DNS_IP" ] && hostname -I | tr ' ' '\n' | grep -qxF "$DNS_IP"; then
  sleep 5
  curl -s -o /dev/null -w "    $PUBLIC_URL -> HTTP %{http_code}\n" "$PUBLIC_URL/" || true
else
  echo "    DNS for $PUBLIC_HOST does not point to this server yet."
  echo "    Caddy will fetch the HTTPS certificate automatically once it does."
fi
echo "Done. Public URL: $PUBLIC_URL"
