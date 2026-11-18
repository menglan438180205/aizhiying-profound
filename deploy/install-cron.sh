#!/usr/bin/env bash
# ==================================================================
# AI智盈 · 安装证书自动续期定时器
# ------------------------------------------------------------------
# 作用：接管 Certbot 自带的续期机制，改为每天凌晨 3 点跑 deploy/renew-cert.sh
# 为什么要接管：Certbot 自带的 certbot.timer 在续期时不会让出 80 端口，
#               在我们的部署形态下（Nginx 容器常驻 80）必然失败。
# 用法：sudo bash deploy/install-cron.sh
# ==================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aizhiying}"

c_ok='\033[32m'; c_warn='\033[33m'; c_err='\033[31m'; c_r='\033[0m'
ok()   { printf "${c_ok}[ OK ]${c_r} %s\n" "$*"; }
warn() { printf "${c_warn}[WARN]${c_r} %s\n" "$*"; }
die()  { printf "${c_err}[FAIL]${c_r} %s\n" "$*"; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "请以 root 运行：sudo bash deploy/install-cron.sh"
[[ -x "${APP_DIR}/deploy/renew-cert.sh" ]] || die "找不到 ${APP_DIR}/deploy/renew-cert.sh"

chmod +x "${APP_DIR}"/deploy/*.sh

# 关掉 Certbot 自带的 timer —— 它对我们的架构无效，留着只会每 12 小时失败一次
if systemctl list-unit-files 2>/dev/null | grep -q 'certbot.timer'; then
  systemctl disable --now certbot.timer >/dev/null 2>&1 || true
  ok "已停用 certbot.timer（改由本脚本的 cron 接管）"
fi

CRON_FILE="/etc/cron.d/aizhiying-cert"
cat > "$CRON_FILE" <<EOF
# AI智盈 TLS 证书续期：每天凌晨 3:07 检查，到期不足 30 天才会真正续期
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
7 3 * * * root ${APP_DIR}/deploy/renew-cert.sh >> /var/log/aizhiying-cert.log 2>&1
EOF
chmod 644 "$CRON_FILE"
touch /var/log/aizhiying-cert.log
ok "已写入定时器：$CRON_FILE"

# 部分精简镜像没装/没起 cron，顺手兜一下
if command -v systemctl >/dev/null 2>&1; then
  for svc in cron crond; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}.service"; then
      systemctl enable --now "$svc" >/dev/null 2>&1 || true
      ok "已启用 ${svc} 服务"
      break
    fi
  done
fi

echo
ok "证书自动续期已就位。日志：/var/log/aizhiying-cert.log"
echo "   想立刻验证脚本能不能跑：sudo bash ${APP_DIR}/deploy/renew-cert.sh"
