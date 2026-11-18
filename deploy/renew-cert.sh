#!/usr/bin/env bash
# ==================================================================
# AI智盈 · TLS 证书续期（由 install-cron.sh 每天自动调用一次）
# ------------------------------------------------------------------
# 为什么要单独写这个脚本：
#   Certbot 用 standalone 方式签发时占用 80 端口，而线上 Nginx 容器常驻 80。
#   如果放任 Certbot 自带的 timer 去续期，它会因端口被占而失败 ——
#   失败本身很安静，等到证书过期那一刻站点才突然不可用。
#
#   所以流程必须是：停 Nginx → 续期 → 同步证书到 nginx/certs → 起 Nginx → reload。
#   只要任一环节出错，trap 都会保证 Nginx 被重新拉起，不会把站点晾在那儿。
#
# 手动执行：sudo bash deploy/renew-cert.sh
# ==================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aizhiying}"
DOMAIN="${DOMAIN:-www.aizhiying.online}"
CERT_LIVE="/etc/letsencrypt/live/${DOMAIN}"

c_ok='\033[32m'; c_warn='\033[33m'; c_err='\033[31m'; c_r='\033[0m'
ok()   { printf "${c_ok}[ OK ]${c_r} %s\n" "$*"; }
warn() { printf "${c_warn}[WARN]${c_r} %s\n" "$*"; }
die()  { printf "${c_err}[FAIL]${c_r} %s\n" "$*"; exit 1; }

cd "$APP_DIR"

# 兜底：脚本以任何方式退出，都确保 Nginx 重新起来
ensure_nginx_up() {
  docker compose start nginx >/dev/null 2>&1 || true
}
trap ensure_nginx_up EXIT

[[ -d "$CERT_LIVE" ]] || die "找不到证书目录 $CERT_LIVE。请先在 $APP_DIR 跑一次 deploy/deploy.sh"

# 距离到期超过 30 天时 certbot 不会真的续期，这是正常行为，不必报错
echo "[$(date '+%F %T')] 开始证书续期检查 ..."
docker compose stop nginx >/dev/null 2>&1 || true
sleep 1

certbot renew --standalone --non-interactive --quiet

cp -Lf "${CERT_LIVE}/fullchain.pem" nginx/certs/fullchain.pem
cp -Lf "${CERT_LIVE}/privkey.pem"   nginx/certs/privkey.pem
chmod 644 nginx/certs/fullchain.pem
chmod 600 nginx/certs/privkey.pem

docker compose start nginx >/dev/null 2>&1 || true
sleep 2
# 容器内 reload，让 Nginx 重新读取磁盘上的证书文件
docker compose exec -T nginx nginx -s reload >/dev/null 2>&1 || true

EXPIRY="$(openssl x509 -enddate -noout -in nginx/certs/fullchain.pem 2>/dev/null | cut -d= -f2 || echo '未知')"
ok "续期检查完成，证书有效期至：${EXPIRY}"
