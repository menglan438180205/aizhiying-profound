#!/usr/bin/env bash
# ==================================================================
# AI智盈 · 一键上线脚本（可重复执行；更新代码后再跑一次即可生效）
# ------------------------------------------------------------------
# 前置：已跑过 bootstrap.sh，且域名已解析到本机公网 IP
# 用法：cd /opt/aizhiying && sudo bash deploy/deploy.sh
#
# 可选环境变量：
#   DOMAIN       主域名，默认 www.aizhiying.online
#   APEX_DOMAIN  根域名，默认 aizhiying.online
#   EMAIL        证书到期通知邮箱（不填则跳过注册邮箱）
#   APP_DIR      应用目录，默认 /opt/aizhiying
#
# 它依次完成：
#   前置检查 → DNS 自检 → 生成 .env → 签发证书 → 启动容器 → 健康验证
# ==================================================================
set -Eeuo pipefail

DOMAIN="${DOMAIN:-www.aizhiying.online}"
APEX_DOMAIN="${APEX_DOMAIN:-aizhiying.online}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/aizhiying}"

c_ok='\033[32m'; c_warn='\033[33m'; c_err='\033[31m'; c_b='\033[1m'; c_r='\033[0m'
ok()   { printf "${c_ok}[ OK ]${c_r} %s\n" "$*"; }
warn() { printf "${c_warn}[WARN]${c_r} %s\n" "$*"; }
die()  { printf "${c_err}[FAIL]${c_r} %s\n" "$*"; exit 1; }
step() { printf "\n${c_b}==> %s${c_r}\n" "$*"; }

CERT_LIVE="/etc/letsencrypt/live/${DOMAIN}"
NEW_TOKEN=""

# ------------------------------------------------------------------
step "1/7  前置检查"
# ------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "请以 root 运行：sudo bash deploy/deploy.sh"
command -v docker >/dev/null 2>&1 || die "Docker 未安装，请先跑 deploy/bootstrap.sh"
docker compose version >/dev/null 2>&1 || die "Docker Compose 插件缺失，请先跑 deploy/bootstrap.sh"
command -v certbot >/dev/null 2>&1 || die "Certbot 未安装，请先跑 deploy/bootstrap.sh"

[[ -d "$APP_DIR" ]] || die "应用目录不存在：$APP_DIR"
cd "$APP_DIR"

missing=0
for f in Dockerfile docker-compose.yml index.html nginx/conf.d; do
  [[ -e "$f" ]] || { warn "缺少：$f"; missing=1; }
done
[[ $missing -eq 0 ]] || die "代码不完整。请确认已把项目上传到 $APP_DIR（Dockerfile / docker-compose.yml / index.html / nginx/ 缺一不可）"
ok "代码完整：$APP_DIR"

# Nginx 站点配置是否已绑定到目标域名（server_name 写成通配也能跑，但会响应任意域名）
if grep -q "server_name _;" nginx/conf.d/*.conf 2>/dev/null; then
  warn "Nginx 的 server_name 仍是通配 '_'，建议改为：server_name ${APEX_DOMAIN} ${DOMAIN};"
else
  ok "Nginx server_name 已指向 ${DOMAIN}"
fi

# ------------------------------------------------------------------
step "2/7  DNS 自检"
# ------------------------------------------------------------------
MY_IP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || curl -fsS -m 10 https://ifconfig.me 2>/dev/null || echo '')"
[[ -n "$MY_IP" ]] || die "取不到本机公网 IP（网络不通），无法完成 DNS 自检"

resolve_ip() { getent hosts "$1" 2>/dev/null | awk 'NR==1{print $1}'; }
WWW_IP="$(resolve_ip "$DOMAIN" || true)"
APEX_IP="$(resolve_ip "$APEX_DOMAIN" || true)"

printf "    本机公网 IP : %s\n" "$MY_IP"
printf "    %-22s -> %s\n" "$DOMAIN" "${WWW_IP:-未解析}"
printf "    %-22s -> %s\n" "$APEX_DOMAIN" "${APEX_IP:-未解析}"

if [[ -z "$WWW_IP" ]]; then
  die "${DOMAIN} 还没有解析记录。请到 DNSPod 添加 A 记录：www -> ${MY_IP}（生效需 1–10 分钟，之后重跑本脚本）"
fi
if [[ "$WWW_IP" != "$MY_IP" ]]; then
  warn "${DOMAIN} 解析到 ${WWW_IP}，与本机 ${MY_IP} 不一致。"
  warn "  如果中间套了 CDN 属正常；否则请修正 DNS —— 证书签发与访问都会失败。"
fi
ok "DNS 自检通过"

# ------------------------------------------------------------------
step "3/7  生成 .env（含 API_TOKEN）"
# ------------------------------------------------------------------
if [[ -f .env ]]; then
  ok "复用已有 .env（不覆盖，避免把你的线上令牌冲掉）"
  if ! grep -qE '^[[:space:]]*API_TOKEN=.+' .env; then
    NEW_TOKEN="$(openssl rand -hex 24)"
    printf '\n# 由 deploy.sh 补全\nAPI_TOKEN=%s\n' "$NEW_TOKEN" >> .env
    ok "已为现有 .env 补全 API_TOKEN"
  fi
else
  NEW_TOKEN="$(openssl rand -hex 24)"
  cat > .env <<EOF
# 由 deploy/deploy.sh 自动生成于 $(date '+%F %T')
# ---------------------------------------------------------------
# 安全：本文件含接口令牌，权限已设为 600，请勿提交到任何代码仓库
# ---------------------------------------------------------------

# 接口鉴权令牌（必填；生产守卫在它为空时会拒绝启动）
API_TOKEN=${NEW_TOKEN}

# 上游通道：留空表示未接入。接了才有真数据，不要开本地模拟开关。
# 采集 / GEO 一旦启用本地模拟，对外输出的就是假数据 —— 这是刻意留空的原因。
COLLECT_UPSTREAM=
COLLECT_TOKEN=
GEO_UPSTREAM=
GEO_TOKEN=

# 支付（未对接支付网关时留空即可）
PAY_PROVIDER=
PAY_GATEWAY=
PAY_MCH_ID=
PAY_NOTIFY_SECRET=

# 渲染（容器内已自带 FFmpeg 与中文字体，通常无需改动）
RENDER_CONCURRENCY=2
RENDER_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc
MAX_UPLOAD_BYTES=536870912

# 下面三个开关在生产必须为「空」（安全/合规红线，非空会导致服务拒绝启动）
QA_MODE=
ALLOW_LOCAL_COLLECT=
ALLOW_LOCAL_GEO=
EOF
  chmod 600 .env
  ok "已生成 .env（权限 600）"
fi
# docker-compose 的环境收口会强制清掉危险开关，这里再兜一层保险
grep -qE '^API_TOKEN=.+' .env || die ".env 中缺少 API_TOKEN，生产模式无法启动"

# ------------------------------------------------------------------
step "4/7  签发 / 更新 TLS 证书"
# ------------------------------------------------------------------
if [[ -f "${CERT_LIVE}/fullchain.pem" ]]; then
  ok "证书已存在（到期会自动续期），跳过签发"
else
  warn "首次签发：需要临时停掉 Nginx 让出 80 端口 ..."
  docker compose stop nginx >/dev/null 2>&1 || true
  sleep 1

  # 只为「确实解析到本机」的域名签发，否则 ACME 校验必然失败
  domains=()
  [[ "$WWW_IP"  == "$MY_IP" ]] && domains+=("$DOMAIN")
  [[ -n "$APEX_IP" && "$APEX_IP" == "$MY_IP" ]] && domains+=("$APEX_DOMAIN")
  ((${#domains[@]})) || die "没有任何域名解析到本机 ${MY_IP}，无法签发证书。请先修 DNS"

  args=()
  for d in "${domains[@]}"; do args+=(-d "$d"); done
  if [[ -n "$EMAIL" ]]; then
    args+=(-m "$EMAIL")
  else
    args+=(--register-unsafely-without-email)
  fi

  certbot certonly --standalone --non-interactive --agree-tos \
    --keep-until-expiring --no-eff-email "${args[@]}"
  ok "证书签发完成，覆盖：${domains[*]}"
fi

mkdir -p nginx/certs
cp -Lf "${CERT_LIVE}/fullchain.pem" nginx/certs/fullchain.pem
cp -Lf "${CERT_LIVE}/privkey.pem"   nginx/certs/privkey.pem
chmod 644 nginx/certs/fullchain.pem
chmod 600 nginx/certs/privkey.pem
ok "证书已同步到 nginx/certs/"

# ------------------------------------------------------------------
step "5/7  构建并启动容器"
# ------------------------------------------------------------------
docker compose up -d --build
ok "容器已启动"

# ------------------------------------------------------------------
step "6/7  等待服务健康（最多 60 秒）"
# ------------------------------------------------------------------
HEALTH_OK=0
for i in $(seq 1 30); do
  if docker compose exec -T bff node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done
[[ $HEALTH_OK -eq 1 ]] || {
  docker compose ps
  docker compose logs --tail=60 bff
  die "BFF 健康检查未通过。上面是容器日志 —— 最常见原因是 .env 的 API_TOKEN 被生产守卫判为缺失。"
}
ok "BFF 健康检查通过"

# ------------------------------------------------------------------
step "7/7  公网验证（走真实域名）"
# ------------------------------------------------------------------
sleep 2
PUB_OK=0
for i in $(seq 1 10); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 "https://${DOMAIN}/v1/health" || echo 000)"
  if [[ "$code" == "200" ]]; then PUB_OK=1; break; fi
  sleep 2
done

echo
if [[ $PUB_OK -eq 1 ]]; then
  ok "公网 HTTPS 访问正常"
  curl -fsS -m 10 "https://${DOMAIN}/v1/health" | head -c 600
  echo
else
  warn "公网 HTTPS 访问未通（HTTP ${code}）。常见原因："
  warn "  1) 云控制台安全组/防火墙没放行 443"
  warn "  2) DNS 还没生效（各地生效速度不同，最长可达数十分钟）"
  warn "  3) 域名未完成实名/备案而使用了中国大陆地域（见 DEPLOY-DOMAIN.md）"
fi

# ------------------------------------------------------------------
cat <<EOF

${c_b}--------------------------------------------------------------
部署完成
--------------------------------------------------------------${c_r}

站点入口：  ${c_b}https://${DOMAIN}/app${c_r}
服务端状态：https://${DOMAIN}/
接口健康：  https://${DOMAIN}/v1/health
EOF

if [[ -n "$NEW_TOKEN" ]]; then
cat <<EOF

${c_warn}${c_b}重要 —— 这一步不做，页面打开后会一直报 401：${c_r}
生产模式强制要求接口令牌。打开 https://${DOMAIN}/app ，
按 F12 打开控制台，粘贴执行（注意是本次新生成的令牌，只显示这一次）：

    PF.setToken('${NEW_TOKEN}')

执行后刷新即可正常使用。令牌请自行保存到密码管理器。

EOF
else
cat <<EOF

本机 .env 已存在，沿用原有 API_TOKEN。
若忘了令牌：grep API_TOKEN ${APP_DIR}/.env

EOF
fi

cat <<EOF
下一步建议：
  · 证书自动续期：sudo bash deploy/install-cron.sh
  · 更新代码后重跑：cd ${APP_DIR} && sudo bash deploy/deploy.sh
  · 看日志：docker compose logs -f bff
EOF
