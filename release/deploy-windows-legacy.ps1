# ProFound one-command deploy (run locally)
# ---------------------------------------------------------------
# Usage:
#   powershell -File release\deploy.ps1                        # deploy index.html only
#   powershell -File release\deploy.ps1 -Files index.html,server/index.js,server/auth.js
#   powershell -File release\deploy.ps1 -SkipGate -NoVerify    # emergency
#
# What it does:
#   1) local gate: syntax of all server js + inline scripts + required markers
#   2) upload remote-swap.ps1 (kept on server, generic)
#   3) scp each target as <target>.new
#   4) run remote-swap.ps1: backup -> syntax check -> swap -> restart BFF -> verify -> auto rollback
#   5) verify public /app/ byte-for-byte against local sha256

param(
  # accepts either an array or a comma separated string
  [string[]]$Files = @('index.html'),
  [switch]$SkipGate,
  [switch]$NoVerify
)

$Files = @($Files | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # avoid massive progress spam in console
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$key  = 'C:\Users\ALIENWARE\.ssh\aizhiying_workbuddy'
$srv  = 'Administrator@118.25.44.79'
$base = 'C:\aizhiying'

function Run-Ssh([string]$cmd) {
  $sshArgs = @('-i', $key, '-o', 'ConnectTimeout=15', $srv, $cmd)
  # pipe to Out-Host so ssh output does not get captured into the return value
  & ssh @sshArgs | Out-Host
  return $LASTEXITCODE
}

Write-Host '=== 1. local gate ==='
if (-not $SkipGate) {
  & node (Join-Path $here 'gate.js')
  if ($LASTEXITCODE -ne 0) { Write-Host 'ABORT: gate failed'; exit 1 }
} else { Write-Host 'skipped' }

Write-Host '=== 2. sync remote swapper ==='
$rc = Run-Ssh 'echo ping'
if ($rc -ne 0) { Write-Host 'ABORT: ssh unreachable'; exit 1 }
& scp -i $key (Join-Path $here 'remote-swap.ps1') ($srv + ':' + $base + '/remote-swap.ps1')
if ($LASTEXITCODE -ne 0) { Write-Host 'ABORT: scp remote-swap failed'; exit 1 }

Write-Host '=== 3. upload targets ==='
$local = @{}
foreach ($f in $Files) {
  $src = Join-Path $repo $f
  if (-not (Test-Path $src)) { Write-Host ('ABORT: local file missing ' + $f); exit 1 }
  $dst = ($srv + ':' + ($base + '\' + ($f -replace '/', '\') + '.new'))
  & scp -i $key $src $dst
  if ($LASTEXITCODE -ne 0) { Write-Host ('ABORT: scp failed ' + $f); exit 1 }
  $local[$f] = (Get-FileHash $src -Algorithm SHA256).Hash
  Write-Host ('uploaded ' + $f + '  ' + (Get-Item $src).Length + ' bytes')
}

Write-Host '=== 4. remote swap + restart ==='
$rc = Run-Ssh 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/aizhiying/remote-swap.ps1'
if ($rc -ne 0) { Write-Host ('ABORT: remote swap exit=' + $rc); exit 1 }

if ($NoVerify) { Write-Host 'verify skipped'; exit 0 }

Write-Host '=== 5. verify public ==='
if ($local.ContainsKey('index.html')) {
  $want = $local['index.html']
  $match = $false
  for ($i = 1; $i -le 6; $i++) {
    $tmp = Join-Path $env:TEMP ('pf-app-' + $i + '-' + (Get-Date -Format 'HHmmss') + '.html')
    try {
      # use curl.exe, not Invoke-WebRequest: PS5.1 re-encodes text bodies and breaks byte comparison
      & curl.exe -s -m 25 -o $tmp `
        -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' `
        -H 'Accept-Encoding: identity' -H 'Cache-Control: no-cache' `
        'https://aizhiying.online/app/'
      $h = (Get-FileHash $tmp -Algorithm SHA256).Hash
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      if ($h -eq $want) { Write-Host 'SHA256 MATCH - public page identical to local'; $match = $true; break }
      Write-Host ('try ' + $i + ': public=' + $h.Substring(0,16) + ' local=' + $want.Substring(0,16) + ' (cdn lag, retrying)')
      Start-Sleep -Seconds 4
    } catch {
      Write-Host ('try ' + $i + ': fetch failed')
      Start-Sleep -Seconds 3
    }
  }
  if (-not $match) {
    Write-Host 'WARN: hash mismatch after 6 tries.'
    Write-Host '      If the server file is correct this is Cloudflare cache; purge it in the dashboard.'
  }
}

try {
  $h = Invoke-WebRequest -Uri 'https://aizhiying.online/v1/health' -UseBasicParsing -TimeoutSec 15
  Write-Host ('health ' + $h.StatusCode + ' ' + $h.Content.Substring(0, [Math]::Min(70, $h.Content.Length)))
} catch { Write-Host 'WARN: health check failed' }

Write-Host '=== DEPLOY DONE ==='
