#!/usr/bin/env bash
#
# 为内置 Nginx 签发 Let's Encrypt 证书并切换到 HTTPS。
#
# 用法:
#   bash scripts/setup-ssl.sh <域名> <邮箱>
# 示例:
#   bash scripts/setup-ssl.sh clash.example.com me@example.com
#
# 前置:
#   - 域名 A/AAAA 记录已指向本机
#   - 宿主机 80 端口可被公网访问（HTTP-01 校验）
#   - 已安装 docker / docker compose v2
#
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "用法: bash scripts/setup-ssl.sh <域名> <邮箱>" >&2
  echo "示例: bash scripts/setup-ssl.sh clash.example.com me@example.com" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p nginx/webroot nginx/letsencrypt

echo "==> 启动 nginx（HTTP，用于 ACME webroot 校验）"
docker compose up -d nginx

echo "==> certbot 签发证书: $DOMAIN"
docker run --rm \
  -v "$ROOT/nginx/webroot:/var/www/certbot" \
  -v "$ROOT/nginx/letsencrypt:/etc/letsencrypt" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email --non-interactive

echo "==> 切换到 HTTPS 配置（nginx/default.conf）"
sed "s/__DOMAIN__/$DOMAIN/g" nginx/default.https.conf > nginx/default.conf

echo "==> 重启 nginx"
docker compose up -d nginx

cat <<EOF

==> 完成：https://$DOMAIN/

后续：
  - 自动续期（建议加入 crontab，每天执行一次即可）：
      0 3 * * * cd $ROOT && bash scripts/renew-ssl.sh >> logs/ssl-renew.log 2>&1
  - 或手动续期：bash scripts/renew-ssl.sh
EOF
