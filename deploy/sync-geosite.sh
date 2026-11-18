#!/usr/bin/env bash
# =========================================================
# sync-geosite.sh — 把「AI秒搭建站」生成的站点同步到公网服务器
# ---------------------------------------------------------
# 前置：
#   1) 已在 ProFound 控制台填好表单并点「一键秒搭建站」，且发布状态条
#      显示「产物已持久化到服务端」（站点落在 <DATA_ROOT>/sites/<站点ID>/）
#   2) 服务器已跑过 deploy/bootstrap.sh（Docker + Nginx + certbot 就绪）
#   3) 本机能 ssh 到服务器
#
# 用法：
#   bash deploy/sync-geosite.sh <站点ID> <服务器IP或域名>
#   bash deploy/sync-geosite.sh gsmvd8ue4g1qf0 47.98.100.200
#
#   # 想让域名首页直接就是生成的站点：
#   bash deploy/sync-geosite.sh <站点ID> <服务器IP> --root
#
# 它会做什么：
#   · 从服务端 API 拉取站点元信息，确认站点存在
#   · 本地拉取全部文件到临时目录
#   · scp 上传到服务器 /var/www/geosite/<站点ID>/（--root 时到 /var/www/geosite-root/）
#   · 重载 Nginx
#   · 提示回来点「校验域名」
# =========================================================
set -euo pipefail

SITE_ID="${1:-}"
HOST="${2:-}"
MODE="${3:-sub}"

if [ -z "$SITE_ID" ] || [ -z "$HOST" ]; then
  echo "用法：bash deploy/sync-geosite.sh <站点ID> <服务器IP或域名> [--root]" >&2
  echo "" >&2
  echo "站点 ID 可在控制台「发布状态」卡片里看到，也可以用：" >&2
  echo "  curl http://127.0.0.1:8787/v1/sites" >&2
  exit 1
fi

BFF="${BFF_BASE:-http://127.0.0.1:8787}"
TOKEN="${API_TOKEN:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> 拉取站点元信息 ($SITE_ID)"
HDR=()
[ -n "$TOKEN" ] && HDR=(-H "Authorization: Bearer $TOKEN")
META="$(curl -sS "${HDR[@]}" "$BFF/v1/sites/$SITE_ID")"

if ! printf '%s' "$META" | grep -q '"meta"'; then
  echo "✗ 站点 $SITE_ID 不存在或服务端未启动（$BFF）" >&2
  exit 2
fi

BRAND="$(printf '%s' "$META" | sed -n 's/.*"brand"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
DOMAIN="$(printf '%s' "$META" | sed -n 's/.*"domain"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
echo "    品牌：$BRAND"
echo "    域名：$DOMAIN"

echo "==> 下载产物到本地临时目录"
printf '%s' "$META" | node -e '
const fs=require("fs"),path=require("path");
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s); const out=process.argv[1];
  const files=j.files||{}; let n=0;
  for(const [name,text] of Object.entries(files)){
    if(text==null) continue;
    const f=path.join(out,name);
    fs.mkdirSync(path.dirname(f),{recursive:true});
    fs.writeFileSync(f,text,"utf8"); n++;
  }
  console.log("    已写出 "+n+" 个文件");
});' "$TMP"

if [ -z "$(ls -A "$TMP")" ]; then
  echo "✗ 没有下载到任何文件，请检查站点是否正确" >&2
  exit 3
fi

if [ "$MODE" = "--root" ]; then
  REMOTE_DIR="/var/www/geosite-root"
else
  REMOTE_DIR="/var/www/geosite/$SITE_ID"
fi

echo "==> 上传到服务器 $HOST:$REMOTE_DIR"
ssh -o StrictHostKeyChecking=accept-new "root@$HOST" "mkdir -p '$REMOTE_DIR'"
scp -r "$TMP"/. "root@$HOST:$REMOTE_DIR/"

echo "==> 重载 Nginx"
if ssh "root@$HOST" "nginx -t 2>&1 | tail -2"; then
  ssh "root@$HOST" "nginx -s reload" || echo "    （重载失败，请到服务器上检查 nginx -t）"
else
  echo "✗ Nginx 配置校验未通过，请先在服务器上检查配置" >&2
  exit 4
fi

echo ""
echo "完成。"
if [ "$MODE" = "--root" ]; then
  echo "  站点根目录   ：https://$DOMAIN/"
  echo "  robots.txt   ：https://$DOMAIN/robots.txt"
  echo "  llms.txt     ：https://$DOMAIN/llms.txt"
  echo "  sitemap.xml  ：https://$DOMAIN/sitemap.xml"
else
  echo "  站点地址     ：https://$DOMAIN/s/$SITE_ID/"
  echo ""
  echo "  ⚠ 子路径托管时 robots/sitemap/llms 不在域名根路径下，"
  echo "    AI 引擎不会当作整站声明读取。要拿到完整 GEO 效果，请用："
  echo "      bash deploy/sync-geosite.sh $SITE_ID $HOST --root"
fi
echo ""
echo "最后一步：回到控制台点「校验域名」，确认 robots / sitemap / llms 三项全通。"
