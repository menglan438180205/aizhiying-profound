#!/usr/bin/env bash
# ==================================================================
# AI智盈 · 轻量服务器「开发/优化」初始化脚本（非 Docker 路线）
# ------------------------------------------------------------------
# 适用：腾讯云轻量应用服务器 / CVM，Ubuntu 22.04+ 或 Debian 12+
# 目的：把云主机变成一个可以反复改代码、秒级重启生效的远程开发环境
#
# 为什么不用 deploy/bootstrap.sh（Docker 路线）：
#   优化代码时每次都要 build 镜像，反馈周期长。本脚本直接跑 Node，
#   配合 scripts/push-dev.sh 可达到「改一行 → 推上去 → 3 秒重载」。
#
# 用法（登录服务器后执行）：
#   sudo bash deploy/dev-init.sh
#   PORT=8787 sudo bash deploy/dev-init.sh      # 自定义端口
#
# 幂等：重复执行安全，已装好的组件会跳过。
# ==================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/aizhiying}"
NODE_DIR="${NODE_DIR:-/opt/node}"
NODE_VER="${NODE_VER:-v22.12.0}"
APP_PORT="${PORT:-8787}"
SVC_NAME="aizhiying"

c_ok='\033[32m'; c_warn='\033[33m'; c_err='\033[31m'; c_b='\033[1m'; c_r='\033[0m'
ok()   { printf "${c_ok}[ OK ]${c_r} %s\n" "$*"; }
warn() { printf "${c_warn}[WARN]${c_r} %s\n" "$*"; }
die()  { printf "${c_err}[FAIL]${c_r} %s\n" "$*"; exit 1; }
step() { printf "\n${c_b}==> %s${c_r}\n" "$*"; }

# ------------------------------------------------------------------
step "1/6  检查执行身份与系统"
# ------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "请以 root 运行：sudo bash deploy/dev-init.sh"

[[ -r /etc/os-release ]] || die "无法识别系统（缺少 /etc/os-release）"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) : ;;
  *) die "本轻量脚本面向 Ubuntu/Debian（当前：${ID:-unknown}）。生产部署请改用 deploy/bootstrap.sh（Docker 路线）。" ;;
esac
ok "系统：${PRETTY_NAME:-$ID}"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  NODE_ARCH=linux-x64   ;;
  aarch64) NODE_ARCH=linux-arm64 ;;
  *) die "暂不支持的 CPU 架构：$ARCH" ;;
esac
ok "架构：$ARCH"

CORE="$(nproc)"
MEM_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
DISK_GB="$(df -BG --output=avail /opt 2>/dev/null | tail -1 | tr -dc '0-9' || echo '?')"
printf "资源：%s 核 · %s MB 内存 · /opt 可用 %s GB\n" "$CORE" "$MEM_MB" "$DISK_GB"
# FFmpeg 是本系统最吃 CPU 的组件，低于 2 核要给明确预警
if [[ "$CORE" -lt 2 ]]; then
  warn "仅 ${CORE} 核：视频渲染会非常慢（一条可能数分钟），建议至少 2 核。"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq curl xz-utils ca-certificates tar >/dev/null
ok "基础工具就绪"

# ------------------------------------------------------------------
step "2/6  Node.js ${NODE_VER}（二进制直装，避免系统源版本过旧）"
# ------------------------------------------------------------------
if [[ -x "$NODE_DIR/bin/node" ]] && "$NODE_DIR/bin/node" -v 2>/dev/null | grep -q "^${NODE_VER#v}"; then
  ok "已安装：$(" $NODE_DIR/bin/node" -v)"
else
  warn "下载安装 Node ${NODE_VER}（约 30 秒）..."
  TARBALL="node-${NODE_VER}-${NODE_ARCH}.tar.xz"
  curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${TARBALL}" -o "/tmp/${TARBALL}" \
    || die "Node 下载失败，请检查网络或改用国内镜像：https://mirrors.cloud.tencent.com/nodejs-release/"
  mkdir -p "$NODE_DIR"
  tar -xJf "/tmp/${TARBALL}" -C "$NODE_DIR" --strip-components=1
  rm -f "/tmp/${TARBALL}"
  ln -sf "$NODE_DIR/bin/node" /usr/local/bin/node
  ln -sf "$NODE_DIR/bin/npm"  /usr/local/bin/npm
  ok "Node 安装完成：$(node -v)"
fi

# ------------------------------------------------------------------
step "3/6  FFmpeg + 中文/西文字体（视频渲染必需）"
# ------------------------------------------------------------------
if command -v ffmpeg >/dev/null 2>&1; then
  ok "已安装：$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
else
  warn "安装 FFmpeg（约 1–3 分钟，含 libx264 编码器）..."
  apt-get install -y -qq ffmpeg >/dev/null || die "FFmpeg 安装失败"
  ok "FFmpeg 安装完成：$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
fi
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q " libx264" \
  && ok "H.264 编码器（libx264）可用" \
  || warn "未检出 libx264，视频渲染可能失败，请改用带完整编码器的 ffmpeg"

# 没有中文字体，渲染出的视频标题会是方块
if fc-list 2>/dev/null | grep -qi "noto.*cjk"; then
  ok "中文字体已就绪（Noto CJK）"
else
  warn "安装中文字体（Noto CJK，约 1 分钟）..."
  apt-get install -y -qq fonts-noto-cjk fontconfig >/dev/null || warn "字体安装失败，视频可能出现方块字"
  fc-cache -f >/dev/null 2>&1 || true
  ok "字体已安装"
fi

# ------------------------------------------------------------------
step "4/6  应用目录与环境变量"
# ------------------------------------------------------------------
mkdir -p "$APP_DIR"
# .data 保留服务端运行状态，初始化时不覆盖已有数据
mkdir -p "$APP_DIR/.data"

# HOST 必须显式为 0.0.0.0：start-local.js 默认绑定 127.0.0.1，
# 那样只有服务器本机能访问，公网打不开。
cat > "$APP_DIR/.env.local" <<EOF
# 由 deploy/dev-init.sh 生成，可手工修改后用 push-dev.sh 重载生效
PORT=${APP_PORT}
# 关键：对外监听。改回 127.0.0.1 则外网无法访问
HOST=0.0.0.0
DATA_DIR=${APP_DIR}/.data

# 腾讯云 CloudBase 自动部署（可选，配好后前端可一键推送站点）
# TCB_SECRET_ID=
# TCB_SECRET_KEY=
# TCB_ENV_ID=
EOF
ok "已写入 $APP_DIR/.env.local（PORT=${APP_PORT} · HOST=0.0.0.0）"

# ------------------------------------------------------------------
step "5/6  systemd 服务（崩溃自动重启、开机自启）"
# ------------------------------------------------------------------
cat > "/etc/systemd/system/${SVC_NAME}.service" <<EOF
[Unit]
Description=AI ZhiYing BFF Service
Documentation=https://github.com/
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
# .env.local 由 start-local.js 读取并注入，此处不必重复声明密钥
ExecStart=${NODE_DIR}/bin/node ${APP_DIR}/start-local.js --foreground
Restart=always
RestartSec=2
StandardOutput=append:${APP_DIR}/.data/server.log
StandardError=append:${APP_DIR}/.data/server.err.log
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SVC_NAME" >/dev/null 2>&1
ok "服务单元已创建：${SVC_NAME}.service"

# ------------------------------------------------------------------
step "6/6  防火墙"
# ------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null 2>&1 || true
  ufw allow "${APP_PORT}/tcp" >/dev/null 2>&1 || true
  echo "y" | ufw enable >/dev/null 2>&1 || true
  ok "ufw 已放通 22 / ${APP_PORT}"
else
  warn "未检测到 ufw；腾讯云端口由「防火墙/安全组」控制（见下方提示）"
fi

# 有还算可用的空闲内存时，给 Node 一个更贴合的上限，避免渲染任务 OOM
if [[ "$MEM_MB" -le 2048 ]]; then
  warn "内存 ${MEM_MB} MB：并发渲染请设为 1，测试时用短时长素材。"
fi

Public_IP="$(curl -fsS -m 8 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '未知')"

cat <<EOF

${c_b}--------------------------------------------------------------
 初始化完成（开发/优化模式）
--------------------------------------------------------------${c_r}

 应用目录    ${APP_DIR}
 Node        $(node -v 2>/dev/null || echo '?')
 公网 IP     ${c_b}${Public_IP}${c_r}

${c_warn}下一步必须做：${c_r}

  1) 在腾讯云控制台放行端口 ${APP_PORT}
     轻量应用服务器 → 「防火墙」→ 添加规则：TCP ${APP_PORT}，来源 0.0.0.0/0
     (CVM 则去「安全组」做同样放行)

  2) 从本机推送代码（Windows Git-Bash 里执行）：
       cd <项目目录>
       bash scripts/push-dev.sh root@${Public_IP}

  3) 浏览器打开验证：
       ${c_b}http://${Public_IP}:${APP_PORT}/app/${c_r}

${c_b}常用运维命令（在服务器上执行）${c_r}
   systemctl status ${SVC_NAME}          # 看状态
   systemctl restart ${SVC_NAME}         # 重启（改了 .env.local 后执行）
   journalctl -u ${SVC_NAME} -f          # 实时看日志
   tail -f ${APP_DIR}/.data/server.log   # 应用日志

EOF
