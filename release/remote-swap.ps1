$ErrorActionPreference = 'Continue'
# Generic remote swapper for C:\aizhiying
# Usage: upload files as <target>.new, then run this script.
# It backs up, syntax-checks server js, swaps, restarts BFF, verifies, and rolls back on failure.

$root = 'C:\aizhiying'
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$changed = @()

Write-Host '=== 1. server js ==='
Get-ChildItem "$root\server\*.new" -ErrorAction SilentlyContinue | ForEach-Object {
  $newFile = $_.FullName
  $target = $newFile -replace '\.new$', ''
  $checkFile = $target + '.check.js'
  Copy-Item $newFile $checkFile -Force
  $out = node --check $checkFile 2>&1 | Out-String
  $code = $LASTEXITCODE
  Remove-Item $checkFile -Force -ErrorAction SilentlyContinue
  if ($code -ne 0) {
    Write-Host ('SYNTAX_FAIL ' + $target + ' :: ' + $out.Trim())
    exit 1
  }
  if (Test-Path $target) { Copy-Item $target ($target + '.bak-' + $ts) -Force }
  Move-Item $newFile $target -Force
  Write-Host ('swapped ' + $target)
  $changed += $target
}

Write-Host '=== 2. index.html ==='
$idx = "$root\index.html"
if (Test-Path "$idx.new") {
  if (Test-Path $idx) { Copy-Item $idx ($idx + '.bak-' + $ts) -Force }
  Move-Item "$idx.new" $idx -Force
  Write-Host ('swapped index.html [' + (Get-Item $idx).Length + ' bytes]')
  $changed += 'index.html'
}

if ($changed.Count -eq 0) { Write-Host 'NOTHING_TO_SWAP'; exit 3 }

Write-Host '=== 3. restart BFF ==='
$listeners = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
foreach ($l in $listeners) {
  Write-Host ('kill PID ' + $l.OwningProcess)
  taskkill /PID $l.OwningProcess /T /F | Out-Null
}
Start-Sleep -Seconds 2
# kill orphan node processes still pointing at the app dir
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match 'aizhiying' -and $_.CommandLine -match 'start-local'
} | ForEach-Object { Write-Host ('kill orphan ' + $_.ProcessId); taskkill /PID $_.ProcessId /T /F | Out-Null }
schtasks /run /tn aizhiying-bff | Out-Null
Write-Host 'scheduled task triggered'

Write-Host '=== 4. verify local ==='
$ok = $false
for ($i = 1; $i -le 25; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/v1/health' -UseBasicParsing -TimeoutSec 6
    if ($r.StatusCode -eq 200) { Write-Host ('local UP after ' + ($i * 3) + 's'); $ok = $true; break }
  } catch { }
}
if (-not $ok) {
  Write-Host 'ROLLBACK: local health failed'
  foreach ($f in $changed) {
    $p = if ($f -eq 'index.html') { $idx } else { $f }
    $bak = $p + '.bak-' + $ts
    if (Test-Path $bak) { Copy-Item $bak $p -Force; Write-Host ('restored ' + $p) }
  }
  $listeners = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  foreach ($l in $listeners) { taskkill /PID $l.OwningProcess /T /F | Out-Null }
  Start-Sleep -Seconds 2
  schtasks /run /tn aizhiying-bff | Out-Null
  exit 2
}

Write-Host '=== 5. verify public ==='
$pub = $false
for ($i = 1; $i -le 6; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri 'https://aizhiying.online/v1/health' -UseBasicParsing -TimeoutSec 10
    if ($r.StatusCode -eq 200) { Write-Host 'public UP'; $pub = $true; break }
  } catch { Write-Host ('public try ' + $i + ' failed') }
}
Write-Host ('=== DONE changed=' + ($changed -join ',') + ' public=' + $pub + ' ===')
Write-Host ('backup suffix: .bak-' + $ts)
