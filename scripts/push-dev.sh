#!/usr/bin/env bash
# ==================================================================
# AI智盈 · 代码推送脚本（本机 → 云服务器）
# ------------------------------------------------------------------
# 用途：把改好的代码推到云上的远程开发环境并自动重载，形成
#       「改代码 → 推送 → 刷新浏览器」的秒级闭环，用来优化代码。
#
# 前置：目标服务器已跑过 deploy/dev-init.sh
#
# 用法（Windows 在 Git-Bash 里执行）：
#   bash scripts/push-dev.sh root@1.2.3.4
#   bash scripts/push-dev.sh root@1.2.3.4 -p 2222       # 自定义 SSH 端口
#   bash scripts/push-dev.sh root@1.2.3.4 --with-env    # 连 .env.local 一起推
#   bash scripts/push-dev.sh root@1.2.3.4 --no-restart  # 只推不重启
#
# 安全设计：
#   · 永远不动服务器上的 .data/ —— 运行数据和成片不会被本机空数据覆盖
#   · 默认不推 .env.local —— 服务器上那份由 dev-init.sh 生成（含 HOST=0.0.0.0）
#   · 推送前先做 Node 语法自检，语法都不通就不浪费一次上传
# ==================================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

c_ok='\033[32m'; c_warn='\033[33m'; c_err='\033[31m'; c_b='\033[1m'; c_r='\033[0m'
ok()   { printf "${c_ok}[ OK ]${c_r} %s\n" "$*"; }
warn() { printf "${c_warn}[WARN]${c_r} %s\n" "$*"; }
die()  { printf "${c_err}[FAIL]${c_r} %s\n" "$*"; exit 1; }
step() { printf "\n${c_b}==> %s${c_r}\n" "$*"; }

TARGET=""
SSH_PORT=22
WITH_ENV=0
DO_RESTART=1
REMOTE_DIR="${REMOTE_DIR:-/opt/aizhiying}"
SVC_NAME="${SVC_NAME:-aizhiying}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port)      SSH_PORT="${2:?缺少端口值}"; shift 2 ;;
    --with-env)     WITH_ENV=1; shift ;;
    --no-restart)   DO_RESTART=0; shift ;;
    --dir)          REMOTE_DIR="${2:?缺少目录}"; shift 2 ;;
    -h|--help)      sed -n '2,25p' "$0"; exit 0 ;;
    -*)             die "未知参数：$1" ;;
    *)              [[ -z "$TARGET" ]] || die "多余的目标：$1"; TARGET="$1"; shift ;;
  esac
done

[[ -n "$TARGET" ]] || die "用法：bash scripts/push-dev.sh root@<服务器IP> [-p 端口] [--with-env]"

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=8 -p "$SSH_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=8 -P "$SSH_PORT")

# ------------------------------------------------------------------
step "1/4  本机自检"
# ------------------------------------------------------------------
[[ -f index.html ]] || die "在错误目录执行？未找到 index.html"
[[ -f start-local.js ]] || die "在错误目录执行？未找到 start-local.js"

command -v tar >/dev/null 2>&1 || die "需要 tar（Git-Bash 默认自带）"
command -v ssh >/dev/null 2>&1 || die "需要 ssh"

# 语法自检：坏代码就不要推上去浪费一次往返
node --check server/index.js 2>/dev/null \
  || die "server/index.js 存在语法错误，请先修复再推送"
BAD=0
while IFS= read -r f; do
  node --check "$f" >/dev/null 2>&1 || { echo "    ✗ $f"; BAD=1; }
done < <(find server scripts -maxdepth 1 -name '*.js' 2>/dev/null)
[[ "$BAD" -eq 0 ]] || die "server/ scripts/ 下有语法错误的文件，已列出，请修复"

ok "语法自检通过"

# ------------------------------------------------------------------
step "2/4  连通性检查"
# ------------------------------------------------------------------
ssh "${SSH_OPTS[@]}" "$TARGET" "test -d '$REMOTE_DIR' || (test -x /usr/local/bin/node && echo '-d missing')" >/dev/null 2>&1 \
  || die "无法 SSH 到 $TARGET（端口 $SSH_PORT）。请确认：公钥已添加 / 服务器已开机 / 安全组放行 22"
ssh "${SSH_OPTS[@]}" "$TARGET" "test -d '$REMOTE_DIR'" 2>/dev/null \
  || warn "远程目录 $REMOTE_DIR 不存在，将在本次推送中创建（请先跑 deploy/dev-init.sh）"
ok "SSH 连通：$TARGET"

# ------------------------------------------------------------------
step "3/4  打包并上传（排除 .data / .build / 依赖）"
# ------------------------------------------------------------------
STAGE="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$STAGE'" EXIT
PKG="$STAGE/aizhiying-$(date +%Y%m%d-%H%M%S).tgz"

EXCLUDES=(
  --exclude=./.data
  --exclude=./.build
  --exclude=./.data-test
  --exclude=./archive
  --exclude=./deliverables
  --exclude=./release
  --exclude=./node_modules
  --exclude=./.git
  --exclude=./.workbuddy
  --exclude=./.DS_Store
  --exclude=*.tgz
  --exclude=*.log
)
# 服务器配置（含 HOST=0.0.0.0）默认保护，不用本机开发配置覆盖
[[ "$WITH_ENV" -eq 1 ]] || EXCLUDES+=(--exclude=./.env.local)

SZ_BEFORE="$(du -sk --exclude=.data --exclude=.build --exclude=node_modules . 2>/dev/null | awk '{print $1}' || echo '?')"
tar -czf "$PKG" "${EXCLUDES[@]}" . 2>/dev/null \
  || tar -czf "$PKG" --exclude=./.data --exclude=./.build --exclude=node_modules . 2>/dev/null \
  || die "打包失败"

SIZE="$(du -h "$PKG" | awk '{print $1}')"
ok "打包完成：$SIZE（源码约 ${SZ_BEFORE} KB）"

scp "${SCP_OPTS[@]}" "$PKG" "$TARGET:/tmp/" >/dev/null 2>&1 \
  || die "上传失败"
ok "已上传到远端 /tmp/"

# ------------------------------------------------------------------
step "4/4  远端解包并重载"
# ------------------------------------------------------------------
REMOTE_PKG="/tmp/$(basename "$PKG")"
# 解包时不删 .data —— 服务端运行数据、已生成的站点与成片全部保留
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p '$REMOTE_DIR' && tar -xzf '$REMOTE_PKG' -C '$REMOTE_DIR' && rm -f '$REMOTE_PKG'" 2>&1 \
  | sed 's/^/    远端: /' || die "远端解包失败"

if command -v ssh >/dev/null && ssh "${SSH_OPTS[@]}" "$TARGET" "systemctl list-unit-files 2>/dev/null | grep -q '^${SVC_NAME}.service'" 2>/dev/null; then
  HAS_SVC=1
else
  HAS_SVC=0
fi

if [[ "$DO_RESTART" -eq 1 ]]; then
  if [[ "$HAS_SVC" -eq 1 ]]; then
    ssh "${SSH_OPTS[@]}" "$TARGET" "systemctl restart ${SVC_NAME} && sleep 2 && systemctl is-active ${SVC_NAME}" 2>&1 \
      | sed 's/^/    远端: /'
  else
    warn "远端未安装 systemd 服务，改用进程重启"
    ssh "${SSH_OPTS[@]}" "$TARGET" "cd '$REMOTE_DIR' && (pkill -f 'server/index.js' || true) && sleep 1 && setsid -f /opt/node/bin/node start-local.js --daemon >/dev/null 2>&1 || true" 2>&1 \
      | sed 's/^/    远端: /'
  fi
fi

# 探活
sleep 2
REMOTE_PORT="$(ssh "${SSH_OPTS[@]}" "$TARGET" "grep -E '^PORT=' '$REMOTE_DIR/.env.local' 2>/dev/null | cut -d= -f2" 2>/dev/null || echo 8787)"
REMOTE_PORT="${REMOTE_PORT:-8787}"
HOST_ONLY="${TARGET#*@}"
if ssh "${SSH_OPTS[@]}" "$TARGET" "curl -fsS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${REMOTE_PORT}/app/" 2>/dev/null | grep -q '^200$'; then
  ok "服务已就绪"
else
  warn "未能从服务端自检出 200，可能是端口${REMOTE_PORT}未放行或启动慢；稍后手工确认"
fi

cat <<EOF

${c_b}--------------------------------------------------------------
 推送完成
--------------------------------------------------------------${c_r}

 目标        ${TARGET}:${REMOTE_PORT}
 访问入口    ${c_b}http://${HOST_ONLY}:${REMOTE_PORT}/app/${c_r}

 提示：若打不开，去腾讯云控制台「防火墙」放行 TCP ${REMOTE_PORT}
 看日志： ssh -p ${SSH_PORT} ${TARGET} "journalctl -u ${SVC_NAME} -f"

EOF
