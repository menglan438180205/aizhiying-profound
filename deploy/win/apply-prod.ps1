<#
  AI 智盈 · production hardening (keeps existing config)
  ------------------------------------------------------------
  Run as Administrator PowerShell on the server:
    powershell -NoProfile -ExecutionPolicy Bypass -File apply-prod.ps1
  What it does:
    1) Installs FFmpeg only (does NOT re-run setup.ps1, so .env.local is not reset to DEMO)
    2) Rewrites .env.local: DEMO off, local-sim off, NODE_ENV=production, sets COLLECT_CRAWLER_URL
    3) Restarts the BFF (scheduled task AIZhiYing-BFF; else prints manual steps)
  Params:
    -AppDir C:\aizhiying
    -CrawlerUrl http://127.0.0.1:8801   # in prod, point to your compliant crawler
    -SkipFfmpeg                          # already have FFmpeg
    -NoRestart                           # only rewrite config
  Note: this script only touches controlled keys; it preserves API_TOKEN / TCB_* / PAY_* / GEO_*.
  Compliance: the crawler channel scrapes third-party platform comment sections, which
  conflicts with the frontend Terms and carries PIPL / unfair-competition risk. Keep the
  crawler limited to owned / authorized content and update the terms (see server/README.md).
#>
param(
  [string]$AppDir = 'C:\aizhiying',
  [string]$CrawlerUrl = 'http://127.0.0.1:8801',
  [string]$FfmpegVer = '7.1',
  [switch]$SkipFfmpeg,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Msg($m)  { Write-Host "  - $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!!] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "[XX] $m" -ForegroundColor Red }

Write-Host ''
Write-Host '=== AI 智盈 · production hardening (keep config) ===' -ForegroundColor Cyan
Write-Host ''

# ---------- 0. app dir ----------
if (-not (Test-Path $AppDir)) { Bad "app dir missing: $AppDir"; exit 1 }
Ok "app dir: $AppDir"

# ---------- 1. install FFmpeg only (do not re-run setup.ps1) ----------
if ($SkipFfmpeg) {
  Msg 'SkipFfmpeg set'
} else {
  if (Test-Path 'C:\ffmpeg\bin\ffmpeg.exe') {
    Ok 'FFmpeg already present: C:\ffmpeg\bin'
  } else {
    $zip = Join-Path $env:TEMP 'ffmpeg.zip'
    # NOTE: gyan.dev prunes version-pinned packages (ffmpeg-7.1-*.zip now 404).
    # Always try the release alias first; it 302s to the current build.
    $urls = @(
      'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-$FfmpegVer-essentials_build.zip",
      "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVer/ffmpeg-$FfmpegVer-essentials_build.zip",
      "https://ghfast.top/https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVer/ffmpeg-$FfmpegVer-essentials_build.zip",
      "https://ghproxy.net/https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVer/ffmpeg-$FfmpegVer-essentials_build.zip"
    )
    # offline first: any ffmpeg*.zip already copied into the app dir
    $offline = Get-ChildItem $AppDir -Filter 'ffmpeg*.zip' -ErrorAction SilentlyContinue |
               Sort-Object Length -Descending | Select-Object -First 1
    if ($offline) {
      Msg "using offline zip: $($offline.FullName)"
      Copy-Item $offline.FullName $zip -Force
    }
    $got = $false
    if (Test-Path $zip) {
      if ((Get-Item $zip).Length -gt 10MB) { $got = $true } else { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
    }
    if (-not $got) {
      foreach ($u in $urls) {
        try {
          Msg "download $u"
          Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 900
          if ((Get-Item $zip).Length -gt 10MB) { $got = $true; break }
        } catch { Msg "fail: $($_.Exception.Message)" }
      }
    }
    if (-not $got) {
      Warn 'FFmpeg download failed: extract essentials_build to C:\ffmpeg\bin manually, then rerun with -SkipFfmpeg'
    } else {
      New-Item -ItemType Directory -Path 'C:\ffmpeg' -Force | Out-Null
      Expand-Archive -Path $zip -DestinationPath 'C:\ffmpeg' -Force
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
      $inner = Get-ChildItem 'C:\ffmpeg' -Directory -ErrorAction SilentlyContinue |
               Where-Object { Test-Path (Join-Path $_.FullName 'bin\ffmpeg.exe') } |
               Select-Object -First 1
      if ($inner) {
        Get-ChildItem $inner.FullName -Force | ForEach-Object {
          Move-Item $_.FullName -Destination 'C:\ffmpeg\' -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $inner.FullName -Recurse -Force -ErrorAction SilentlyContinue
      }
      if (Test-Path 'C:\ffmpeg\bin\ffmpeg.exe') {
        $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        if ($m -notlike '*C:\ffmpeg\bin*') {
          [Environment]::SetEnvironmentVariable('Path', $m + ';C:\ffmpeg\bin', 'Machine')
        }
        Ok 'FFmpeg installed: C:\ffmpeg\bin'
      } else {
        Warn 'FFmpeg not found after extract; check C:\ffmpeg manually'
      }
    }
  }
}

# ---------- 2. rewrite .env.local (preserve API_TOKEN / TCB_* / PAY_* / GEO_*) ----------
$envFile = Join-Path $AppDir '.env.local'
if (-not (Test-Path $envFile)) { Bad "no .env.local at $envFile; run setup.ps1 first"; exit 1 }

$backup = "$envFile.bak-" + (Get-Date -Format 'yyyyMMddHHmmss')
Copy-Item $envFile $backup -Force
Msg "backed up config: $backup"

# keys this script controls (overwritten / written); everything else is preserved
$controlled = @(
  'NODE_ENV','DEMO_MODE','HOST','PORT','DATA_DIR','STATIC_ROOT',
  'ALLOW_LOCAL_COLLECT','ALLOW_LOCAL_GEO','COLLECT_TICK_MS','COLLECT_DEFAULT_CHANNEL',
  'COLLECT_CRAWLER_URL','COLLECT_CRAWLER_TOKEN','QA_MODE',
  'FFMPEG_PATH','FFPROBE_PATH','RENDER_CONCURRENCY'
)

$kept = @{}
$apiToken = ''
foreach ($line in (Get-Content $envFile -Encoding UTF8)) {
  $s = $line.Trim()
  if ($s -eq '' -or $s.StartsWith('#')) { continue }
  $eq = $s.IndexOf('=')
  if ($eq -le 0) { continue }
  $k = $s.Substring(0, $eq).Trim()
  $v = $s.Substring($eq + 1).Trim()
  if ($k -notmatch '^\w+$') { continue }
  if ($k -eq 'API_TOKEN') { $apiToken = $v; continue }
  if ($controlled -contains $k) { continue }
  $kept[$k] = $v
}
if (-not $apiToken) {
  Bad 'no API_TOKEN in existing .env.local; abort to avoid wiping auth'
  exit 1
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# AI 智盈 production config (written by apply-prod.ps1; TCB/PAY/GEO preserved)')
$lines.Add('NODE_ENV=production')
$lines.Add('DEMO_MODE=0')
$lines.Add('HOST=0.0.0.0')
$lines.Add('PORT=8787')
$lines.Add('DATA_DIR=.data')
$lines.Add('STATIC_ROOT=')
$lines.Add('')
$lines.Add('# API_TOKEN (kept from previous config)')
$lines.Add('API_TOKEN=' + $apiToken)
$lines.Add('')
$lines.Add('# render (FFmpeg)')
$lines.Add('FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe')
$lines.Add('FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe')
$lines.Add('RENDER_CONCURRENCY=2')
$lines.Add('')
$lines.Add('# collect: local sim must be OFF in production')
$lines.Add('ALLOW_LOCAL_COLLECT=')
$lines.Add('ALLOW_LOCAL_GEO=')
$lines.Add('COLLECT_TICK_MS=30000')
$lines.Add('COLLECT_DEFAULT_CHANNEL=auto')
$lines.Add('')
$lines.Add('# crawler channel (verify stub on 8801; replace with compliant crawler in prod)')
$lines.Add('COLLECT_CRAWLER_URL=' + $CrawlerUrl)
$lines.Add('# COLLECT_CRAWLER_TOKEN=   # only if untrusted network')
$lines.Add('')
$lines.Add('# ---- preserved existing config (TCB/PAY/GEO etc) ----')
foreach ($k in $kept.Keys) { $lines.Add($k + '=' + $kept[$k]) }

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envFile, ($lines -join [Environment]::NewLine) + [Environment]::NewLine, $utf8)
Ok "wrote production config: $envFile (DEMO off, NODE_ENV=production)"

# ---------- 3. restart BFF ----------
# IMPORTANT: start-service.cmd skips startup when the port is already LISTENING,
# and Stop-ScheduledTask only kills the wrapper cmd.exe while the real node process
# keeps running detached. So we must kill whoever owns the port FIRST, otherwise
# the old process (old env: DEMO on, no FFMPEG_PATH) survives the "restart".
if ($NoRestart) {
  Warn 'NoRestart set: restart BFF manually to apply'
} else {
  $portNum = 8787
  $envPort = 0
  if ($kept.ContainsKey('PORT')) { [void][int]::TryParse($kept['PORT'], [ref]$envPort) }
  if ($envPort -gt 0) { $portNum = $envPort }

  function Get-PortPid([int]$p) {
    try {
      $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
      if ($c) { return [int]$c.OwningProcess }
    } catch { }
    try {
      $lines = & netstat -ano | Select-String (':' + $p + '\s') | Select-String 'LISTENING'
      foreach ($l in $lines) {
        $parts = ($l.ToString()).Trim() -split '\s+'
        $n = 0
        if ([int]::TryParse($parts[$parts.Length - 1], [ref]$n)) { return $n }
      }
    } catch { }
    return 0
  }

  $oldPid = Get-PortPid $portNum
  if ($oldPid -gt 0) {
    Msg "killing old listener on port $portNum (PID $oldPid)"
    & taskkill /PID $oldPid /T /F 2>&1 | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 500
      if ((Get-PortPid $portNum) -eq 0) { break }
    }
    if ((Get-PortPid $portNum) -eq 0) { Ok "old process stopped, port $portNum freed" }
    else { Warn "port $portNum still busy; kill PID $oldPid manually" }
  } else {
    Ok "port $portNum free (no old listener)"
  }

  $pidFile = Join-Path $AppDir '.data\server.pid'
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }

  $taskName = 'AIZhiYing-BFF'
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($t) {
    try {
      Start-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
      Ok "started scheduled task: $taskName"
    } catch {
      Warn "Start-ScheduledTask failed: $($_.Exception.Message)"
    }
  } else {
    Warn "no scheduled task $taskName. Start manually: cd $AppDir; node start-local.js --daemon"
  }
}

Write-Host ''
Write-Host '=== verify after restart ===' -ForegroundColor Cyan
Write-Host '  curl http://127.0.0.1:8787/v1/health  -> check ffmpeg.ok and collect.configured' -ForegroundColor White
Write-Host '  curl "http://127.0.0.1:8787/v1/collect/channels?probe=1"  -> crawler should be ok:true' -ForegroundColor White
Write-Host ''
