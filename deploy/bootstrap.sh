#!/usr/bin/env bash
# ==================================================================
# AI智盈 · 服务器初始化脚本（每台服务器只需执行一次）
# ------------------------------------------------------------------
# 作用：安装 Docker / Docker Compose / Certbot，放通 22·80·443，创建应用目录
# 用法：sudo bash deploy/bootstrap.sh
#
# 设计原则：
#   1) 幂等 —— 重复执行不会破坏已完成的部分（已装好的组件直接跳过）
#   2) 早失败 —— 缺依赖立刻报错，不留下「半装好的环境」
#   3) 不做黑魔法 —— 每一步都打印清楚在干什么
# ==================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aizhiying}"

c_ok='\033[32m'; c_warn='\033[33m'; c_err='\033[31m'; c_b='\033[1m'; c_r='\033[0m'
ok()   { printf "${c_ok}[ OK ]${c_r} %s\n" "$*"; }
warn() { printf "${c_warn}[WARN]${c_r} %s\n" "$*"; }
die()  { printf "${c_err}[FAIL]${c_r} %s\n" "$*"; exit 1; }
step() { printf "\n${c_b}==> %s${c_r}\n" "$*"; }

# ------------------------------------------------------------------
step "1/6  检查执行身份与系统"
# ------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "请以 root 运行：sudo bash deploy/bootstrap.sh"

[[ -r /etc/os-release ]] || die "无法识别系统（缺少 /etc/os-release）"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian)                                              PKG=apt ;;
  centos|rhel|almalinux|rocky|tencentos|opencloudos|fedora)   PKG=yum ;;
  *) die "暂未内建支持的系统：${ID:-unknown}。请手工安装 Docker + Compose + Certbot 后，直接运行 deploy.sh" ;;
esac
ok "系统：${PRETTY_NAME:-$ID}"

if [[ "$PKG" == apt ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y -qq
  apt-get install -y -qq curl openssl >/dev/null
else
  yum install -y -q curl openssl >/dev/null
fi
ok "基础工具（curl / openssl）就绪"

# ------------------------------------------------------------------
step "2/6  Docker 引擎"
# ------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok "已安装：$(docker --version | head -1)"
else
  warn "未检测到 Docker，开始安装（约 1–3 分钟）..."
  if [[ "$PKG" == apt ]]; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
  else
    yum install -y -q yum-utils >/dev/null
    yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    yum install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin >/dev/null
  fi
  systemctl enable --now docker
  ok "Docker 安装完成：$(docker --version | head -1)"
fi
systemctl enable --now docker >/dev/null 2>&1 || true
ok "Docker 服务已开机自启"

# ------------------------------------------------------------------
step "3/6  Docker Compose 插件"
# ------------------------------------------------------------------
if docker compose version >/dev/null 2>&1; then
  ok "已就绪：v$(docker compose version --short 2>/dev/null)"
else
  warn "安装 Compose 插件 ..."
  if [[ "$PKG" == apt ]]; then
    apt-get install -y -qq docker-compose-plugin >/dev/null
  else
    yum install -y -q docker-compose-plugin >/dev/null
  fi
  docker compose version >/dev/null 2>&1 || die "Compose 插件安装失败，请手工安装后重试"
  ok "Compose 安装完成：v$(docker compose version --short 2>/dev/null)"
fi

# ------------------------------------------------------------------
step "4/6  Certbot（签发 Let's Encrypt 免费证书）"
# ------------------------------------------------------------------
if command -v certbot >/dev/null 2>&1; then
  ok "已安装：$(certbot --version 2>/dev/null | head -1)"
else
  warn "安装 Certbot ..."
  if [[ "$PKG" == apt ]]; then
    apt-get install -y -qq certbot >/dev/null
  else
    yum install -y -q epel-release >/dev/null || true
    yum install -y -q certbot >/dev/null
  fi
  command -v certbot >/dev/null 2>&1 || die "Certbot 安装失败，请手工安装后重试"
  ok "Certbot 安装完成"
fi

# ------------------------------------------------------------------
step "5/6  放通端口 22 / 80 / 443"
# ------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  echo "y" | ufw enable >/dev/null 2>&1 || true
  ok "ufw 已放通 22 / 80 / 443"
elif command -v firewall-cmd >/dev/null 2>&1; then
  systemctl enable --now firewalld >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=22/tcp  >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=80/tcp  >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-port=443/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "firewalld 已放通 22 / 80 / 443"
else
  warn "未检测到 ufw / firewalld（多数云镜像默认关闭），端口由云厂商安全组控制 —— 见下方提示"
fi

# ------------------------------------------------------------------
step "6/6  准备应用目录"
# ------------------------------------------------------------------
mkdir -p "$APP_DIR"
ok "应用目录：$APP_DIR"

PUBLIC_IP="$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || curl -fsS -m 10 https://ifconfig.me 2>/dev/null || echo '未知')"

cat <<EOF

${c_b}--------------------------------------------------------------
初始化完成
--------------------------------------------------------------${c_r}

本机公网 IP：${c_b}${PUBLIC_IP}${c_r}

${c_warn}接下来这 3 步必须做（缺一步就无法用 https 打开）：${c_r}

  1) 云控制台放行端口
     · 腾讯云轻量 → 「防火墙」页面；腾讯云/阿里云 CVM → 「安全组」
     · 放行：TCP 22（SSH）、80（HTTP）、443（HTTPS）

  2) 域名解析（你的域名在腾讯云 DNSPod）
     登录 console.dnspod.cn → 域名解析 → aizhiying.online，添加两条 A 记录：
       主机记录  类型  记录值
       @         A     ${PUBLIC_IP}
       www       A     ${PUBLIC_IP}
     生效时间通常 1–10 分钟。

  3) 上传代码后执行上线脚本
       cd ${APP_DIR}
       sudo bash deploy/deploy.sh

EOF
