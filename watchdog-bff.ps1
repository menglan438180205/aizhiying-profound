$ErrorActionPreference = 'SilentlyContinue'
$port = 8787
$healthUrl = "http://127.0.0.1:$port/v1/health"
$log = Join-Path $PSScriptRoot 'watchdog.log'
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

function Log($msg) {
  Add-Content -Path $log -Value "$timestamp  $msg"
}

# Require 3 consecutive failed health checks before declaring BFF dead.
# This avoids killing a BFF that is merely slow to warm up (false restart churn).
$maxFail = 3
$fail = 0
for ($i = 1; $i -le $maxFail; $i++) {
  try {
    $r = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { exit 0 }
  } catch {}
  $fail++
  if ($i -lt $maxFail) { Start-Sleep -Seconds 3 }
}

Log "WATCHDOG: BFF not healthy after $maxFail checks, attempting restart"

$pids = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
foreach ($p in $pids) {
  if ($p) {
    Log "WATCHDOG: killing PID $p on port $port"
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 2

Remove-Item (Join-Path $PSScriptRoot '.data\server.pid') -Force -ErrorAction SilentlyContinue

try {
  # 统一入口：生产机上由 setup.ps1 复制到根目录的 start.cmd；
  # 源码目录里没有该文件时回退到 deploy\win\start.cmd（同一份脚本）。
  $starter = Join-Path $PSScriptRoot 'start.cmd'
  if (-not (Test-Path $starter)) { $starter = Join-Path $PSScriptRoot 'deploy\win\start.cmd' }
  Start-Process -FilePath $starter -WindowStyle Hidden -ErrorAction Stop
  Log "WATCHDOG: launched $starter"
} catch {
  Log "WATCHDOG: failed to launch starter: $_"
}

Start-Sleep -Seconds 8
try {
  $r2 = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 5 -UseBasicParsing
  if ($r2.StatusCode -eq 200) { Log "WATCHDOG: BFF recovered OK" }
  else { Log "WATCHDOG: BFF still unhealthy after restart (HTTP $($r2.StatusCode))" }
} catch {
  Log "WATCHDOG: BFF still down after restart"
}
