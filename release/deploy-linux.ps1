# ProFound one-command deploy for the Ubuntu production server.
# Usage:
#   powershell -File release\deploy-linux.ps1
#   powershell -File release\deploy-linux.ps1 -Files index.html,server/index.js,server/auth.js
#   powershell -File release\deploy-linux.ps1 -SkipGate -NoVerify
#
# Server: ubuntu@62.234.109.9  /opt/aizhiying
# Services: aizhiying.service + cloudflared.service
# Safety: upload to /tmp, back up old files, node --check new JS, swap, restart,
#         health check, auto rollback if health fails.

param(
  [string[]]$Files = @('index.html'),
  [switch]$SkipGate,
  [switch]$NoVerify
)

$Files = @($Files | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$key  = 'C:\Users\ALIENWARE\.ssh\aizhiying_workbuddy'
$srv  = 'ubuntu@62.234.109.9'
$base = '/opt/aizhiying'
$stage = '/tmp/aizy-deploy'

function Run-Ssh([string]$cmd) {
  & ssh -i $key -o ConnectTimeout=15 $srv $cmd | Out-Host
  return $LASTEXITCODE
}

Write-Host '=== 1. local gate ==='
if (-not $SkipGate) {
  & node (Join-Path $here 'gate.js')
  if ($LASTEXITCODE -ne 0) { Write-Host 'ABORT: gate failed'; exit 1 }
} else { Write-Host 'skipped' }

$rels = @()
foreach ($f in $Files) {
  $rel = (($f -replace '\\', '/').Trim()).TrimStart('/')
  if (-not $rel -or $rel -match '(^|/)\.\.(/|$)') { Write-Host ('ABORT: bad path ' + $f); exit 1 }
  $src = Join-Path $repo ($rel -replace '/', '\')
  if (-not (Test-Path $src)) { Write-Host ('ABORT: local file missing ' + $rel); exit 1 }
  $rels += $rel
}
$rels = @($rels | Select-Object -Unique)

Write-Host '=== 2. check server ==='
$rc = Run-Ssh 'echo ping'
if ($rc -ne 0) { Write-Host 'ABORT: ssh unreachable'; exit 1 }
$rc = Run-Ssh "rm -rf $stage && mkdir -p $stage"
if ($rc -ne 0) { Write-Host 'ABORT: cannot prepare staging dir'; exit 1 }

Write-Host '=== 3. upload targets ==='
foreach ($rel in $rels) {
  $src = Join-Path $repo ($rel -replace '/', '\')
  $dir = Split-Path $rel -Parent
  if ($dir -and $dir -ne '.') {
    $rc = Run-Ssh "mkdir -p '$stage/$dir'"
    if ($rc -ne 0) { Write-Host ('ABORT: mkdir ' + $dir); exit 1 }
  }
  & scp -i $key -o ConnectTimeout=15 $src ($srv + ':' + $stage + '/' + $rel)
  if ($LASTEXITCODE -ne 0) { Write-Host ('ABORT: scp failed ' + $rel); exit 1 }
  Write-Host ('uploaded ' + $rel + '  ' + (Get-Item $src).Length + ' bytes')
}

Write-Host '=== 4. syntax check + swap + restart ==='
$list = ($rels | ForEach-Object { "'" + $_ + "'" }) -join ' '
$remote = @'
set -e
BASE='__BASE__'
STAGE='__STAGE__'
BACK="/tmp/aizy-deploy-bak-$(date +%Y%m%d%H%M%S)"
mkdir -p "$BACK"

for rel in __LIST__; do
  src="$STAGE/$rel"
  dst="$BASE/$rel"
  [ -f "$src" ] || { echo "missing $src"; exit 1; }
  if [ -f "$dst" ]; then
    mkdir -p "$BACK/$(dirname "$rel")"
    cp -a "$dst" "$BACK/$rel"
  fi
done

# Syntax check every uploaded .js before touching production.
for rel in __LIST__; do
  case "$rel" in
    *.js) node --check "$STAGE/$rel" ;;
  esac
done

for rel in __LIST__; do
  install -D -o aizhiying -g aizhiying -m 644 "$STAGE/$rel" "$BASE/$rel"
done

systemctl restart aizhiying
sleep 6
if ! curl -fsS --max-time 8 http://127.0.0.1:8787/v1/health >/dev/null; then
  echo "health failed; rolling back"
  for rel in __LIST__; do
    if [ -f "$BACK/$rel" ]; then
      install -D -o aizhiying -g aizhiying -m 644 "$BACK/$rel" "$BASE/$rel"
    fi
  done
  systemctl restart aizhiying
  exit 1
fi
echo "deploy ok; backup=$BACK"
'@
$remote = $remote.Replace('__BASE__', $base).Replace('__STAGE__', $stage).Replace('__LIST__', $list)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
& ssh -i $key -o ConnectTimeout=15 $srv ("echo " + $b64 + " | base64 -d | sudo bash")
if ($LASTEXITCODE -ne 0) { Write-Host 'ABORT: remote swap failed'; exit 1 }

if ($NoVerify) { Write-Host 'verify skipped'; exit 0 }

Write-Host '=== 5. verify public ==='
try {
  $h = Invoke-WebRequest -Uri 'https://www.aizhiying.online/v1/health' -UseBasicParsing -TimeoutSec 20
  Write-Host ('health ' + $h.StatusCode)
} catch { Write-Host 'WARN: public health check failed' }

if ($rels -contains 'index.html') {
  $want = (Get-FileHash (Join-Path $repo 'index.html') -Algorithm SHA256).Hash
  $match = $false
  for ($i = 1; $i -le 6; $i++) {
    $tmp = Join-Path $env:TEMP ('pf-app-' + $i + '-' + (Get-Date -Format 'HHmmss') + '.html')
    try {
      & curl.exe -s -m 25 -o $tmp `
        -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' `
        -H 'Accept-Encoding: identity' -H 'Cache-Control: no-cache' `
        'https://www.aizhiying.online/app/'
      $got = (Get-FileHash $tmp -Algorithm SHA256).Hash
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      if ($got -eq $want) { Write-Host 'SHA256 MATCH - public page identical to local'; $match = $true; break }
      Write-Host ('try ' + $i + ': public=' + $got.Substring(0, 16) + ' local=' + $want.Substring(0, 16) + ' (retrying)')
      Start-Sleep -Seconds 4
    } catch {
      Write-Host ('try ' + $i + ': fetch failed')
      Start-Sleep -Seconds 3
    }
  }
  if (-not $match) { Write-Host 'WARN: hash mismatch; check Cloudflare cache' }
}

Write-Host '=== DEPLOY DONE ==='
