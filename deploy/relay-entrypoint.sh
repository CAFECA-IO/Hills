#!/bin/sh
# 依環境變數產生 iroh-relay 設定（docs/deploy.md §2）。
# /config/relay.toml 存在且為檔案時優先使用（進階設定）。
set -eu

if [ -f /config/relay.toml ]; then
  exec iroh-relay --config-path /config/relay.toml
fi

: "${HILLS_RELAY_HOST:?請在 .env 設定 HILLS_RELAY_HOST}"
: "${HILLS_RELAY_CONTACT:?請在 .env 設定 HILLS_RELAY_CONTACT}"

cat > /data/relay.toml <<CONF
enable_relay = true
http_bind_addr = "[::]:80"
enable_quic_addr_discovery = true

[tls]
hostname = "${HILLS_RELAY_HOST}"
cert_mode = "LetsEncrypt"
contact = "${HILLS_RELAY_CONTACT}"
cert_dir = "/data/certs"
CONF

echo "relay：${HILLS_RELAY_HOST}（LetsEncrypt）"
exec iroh-relay --config-path /data/relay.toml
