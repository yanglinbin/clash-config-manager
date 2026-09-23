#!/usr/bin/env bash
#
# 续期 Let's Encrypt 证书并让 nginx 重新加载。
# 建议加入 crontab，每天执行一次（certbot 仅在临近到期时才会真正续期）：
#   0 3 * * * cd /path/to/clash-config-manager && bash scripts/renew-ssl.sh >> logs/ssl-renew.log 2>&1
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p nginx/webroot nginx/letsencrypt

echo "==> certbot renew"
docker run --rm \
  -v "$ROOT/nginx/webroot:/var/www/certbot" \
  -v "$ROOT/nginx/letsencrypt:/etc/letsencrypt" \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet

echo "==> reload nginx"
docker compose exec -T nginx nginx -s reload || docker compose restart nginx

echo "==> 完成"
