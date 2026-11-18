<#
  AI 智盈全栈系统 · Windows Server 一键初始化
  ------------------------------------------------------------
  以【管理员 PowerShell】执行：
    powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1
  可选参数：
    -AppDir C:\aizhiying     应用安装目录
    -Port   8787             对外端口
    -SkipNode                已装 Node 时跳过
    -SkipFfmpeg              暂不装 FFmpeg（渲染功能会不可用）
    -NoTask                  不注册开机自启计划任务
  ------------------------------------------------------------
#>
param(
  [string]$AppDir = 'C:\aizhiying',
  [string]$Port   = '8787',
  [string]$NodeVer = '22.12.0',
  [string]$FfmpegVer = '7.1',
  [switch]$SkipNode,
  [switch]$SkipFfmpeg,
  [switch]$NoTask
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Msg($m)  { Write-Host "  - $m" -ForegroundColor Gray }
function Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!!] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "[XX] $m" -ForegroundColor Red }

Write-Host ''
Write-Host '=== AI 智盈 · 服务器初始化 ===' -ForegroundColor Cyan
Write-Host ''

# ---------- 0. 权限探测 ----------
# 有管理员就全量做；没有则降级：仍然生成配置，但跳过写机器级 PATH、防火墙、计划任务。
$cur = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr  = New-Object Security.Principal.WindowsPrincipal($cur)
$IsAdmin = $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($IsAdmin) { Ok '已获取管理员权限，将执行全部步骤' }
else { Warn '当前非管理员：环境写入、防火墙、开机自启会被跳过（不影响生成配置）' }

# ---------- 1. 目录 ----------
if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir -Force | Out-Null }
Ok "应用目录： $AppDir"

# ---------- 2. Node.js ----------
if ($SkipNode) {
  Msg '已指定跳过 Node 安装'
} else {
  $need = $true
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $v = (node -v 2>$null)
    if ($v -eq "v$NodeVer") { Ok "Node 已就绪： $v"; $need = $false }
    else { Msg "已存在 Node $v，将安装 $NodeVer（并存，以新版本为准）" }
  }
  if ($need) {
    $msi  = Join-Path $env:TEMP "node-v$NodeVer-x64.msi"
    $urls = @(
      "https://mirrors.cloud.tencent.com/nodejs-release/v$NodeVer/node-v$NodeVer-x64.msi",
      "https://nodejs.org/dist/v$NodeVer/node-v$NodeVer-x64.msi",
      "https://npmmirror.com/mirrors/node/v$NodeVer/node-v$NodeVer-x64.msi"
    )
    $got = $false
    foreach ($u in $urls) {
      try {
        Msg "下载 $u"
        Invoke-WebRequest -Uri $u -OutFile $msi -UseBasicParsing -TimeoutSec 600
        if ((Get-Item $msi).Length -gt 5MB) { $got = $true; break }
      } catch { Msg "失败：$($_.Exception.Message)" }
    }
    if (-not $got) { Bad 'Node 安装包下载失败，可手工下载后重跑（加 -SkipNode 跳过）'; exit 1 }
    Msg '静默安装中…'
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart ADDLOCAL=ALL" -Wait -NoNewWindow
    Remove-Item $msi -Force -ErrorAction SilentlyContinue
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if ($machine -notlike '*nodejs*') {
      [Environment]::SetEnvironmentVariable('Path', $machine + ';C:\Program Files\nodejs\', 'Machine')
      $env:Path += ';C:\Program Files\nodejs\'
    }
    Ok "Node 安装完成： $(node -v)"
  }
}

# ---------- 3. FFmpeg ----------
if ($SkipFfmpeg) {
  Warn '跳过 FFmpeg：视频渲染类功能不可用，其它功能正常'
} else {
  if (Test-Path 'C:\ffmpeg\bin\ffmpeg.exe') {
    Ok 'FFmpeg 已就绪： C:\ffmpeg\bin'
  } else {
    $zip  = Join-Path $env:TEMP 'ffmpeg.zip'
    $urls = @(
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
      "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVer/ffmpeg-$FfmpegVer-essentials_build.zip",
      "https://ghproxy.net/https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVer/ffmpeg-$FfmpegVer-essentials_build.zip"
    )
    $got = $false
    foreach ($u in $urls) {
      try {
        Msg "下载 $u"
        Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 900
        if ((Get-Item $zip).Length -gt 10MB) { $got = $true; break }
      } catch { Msg "失败：$($_.Exception.Message)" }
    }
    if (-not $got) {
      Warn 'FFmpeg 下载失败，跳过（可稍后手工放到 C:\ffmpeg\bin）'
    } else {
      New-Item -ItemType Directory -Path 'C:\ffmpeg' -Force | Out-Null
      Expand-Archive -Path $zip -DestinationPath 'C:\ffmpeg' -Force
      Remove-Item $zip -Force -ErrorAction SilentlyContinue
      # 包内多一层 ffmpeg-<ver>-essentials_build\，把它提上来
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
        Ok 'FFmpeg 安装完成： C:\ffmpeg\bin'
      } else {
        Warn 'FFmpeg 解压后未找到 bin\ffmpeg.exe，请手工检查 C:\ffmpeg'
      }
    }
  }
}

# ---------- 4. 随机 API_TOKEN ----------
function New-Token {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $b = New-Object byte[] 20
  $rng.GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}
$token = New-Token

# ---------- 5. 写 .env.local ----------
$envFile = Join-Path $AppDir '.env.local'
if (Test-Path $envFile) {
  $old = Get-Content $envFile -Raw -Encoding UTF8
  $m = [regex]::Match($old, '(?m)^API_TOKEN=(.*)$')
  if ($m.Success -and $m.Groups[1].Value.Trim() -ne '') {
    $token = $m.Groups[1].Value.Trim()
    Msg '沿用已有 .env.local 中的 API_TOKEN'
  }
  Copy-Item $envFile "$envFile.bak" -Force
  Msg '已备份原配置为 .env.local.bak'
}

$lines = @(
  '# AI 智盈 · 服务器配置（由 deploy/win/setup.ps1 生成）',
  'NODE_ENV=development',
  'DEMO_MODE=1',
  'HOST=0.0.0.0',
  "PORT=$Port",
  'DATA_DIR=.data',
  'STATIC_ROOT=',
  '',
  '# 对外令牌：留空则全站免鉴权，切勿在公网留空',
  "API_TOKEN=$token",
  '',
  '# 渲染（FFmpeg）',
  'FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe',
  'FFPROBE_PATH=C:\ffmpeg\bin\ffprobe.exe',
  'RENDER_CONCURRENCY=2',
  '',
  '# 演示数据源（DEMO_MODE=1 时生效）',
  'ALLOW_LOCAL_COLLECT=1',
  'ALLOW_LOCAL_GEO=1',
  'COLLECT_TICK_MS=30000',
  '',
  '# 关闭 QA 后门',
  'QA_MODE=0'
)
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envFile, ($lines -join "`r`n") + "`r`n", $utf8)
Ok "已写入配置： $envFile"

# ---------- 6. 防火墙 ----------
$ruleName = "AIZhiYing-$Port"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP `
    -LocalPort $Port -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
  Ok "Windows 防火墙已放通 TCP $Port"
} else {
  Ok "防火墙规则已存在： $ruleName"
}

# ---------- 7. 开机自启（计划任务） ----------
if ($NoTask) {
  Msg '已指定不注册自启任务'
} else {
  $taskName = 'AIZhiYing-BFF'
  $starter = Join-Path $AppDir 'start.cmd'
  if (Test-Path $starter) {
    $act  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$starter`"" -WorkingDirectory $AppDir
    $trg  = New-ScheduledTaskTrigger -AtStartup
    $set  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Settings $set `
      -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    Ok "已注册开机自启任务： $taskName"
  } else {
    Warn "未找到 $starter，跳过自启注册（代码就位后重跑本脚本即可）"
  }
}

# ---------- 8. 结果 ----------
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
        Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ''
Write-Host '=== 初始化完成 ===' -ForegroundColor Cyan
Write-Host "  应用目录   $AppDir"
Write-Host "  对外端口   $Port"
Write-Host "  本机 IP    $ip"
Write-Host ''
Write-Host '  下一步：'
Write-Host "   1) 把代码包解压到 $AppDir（保持目录结构）"
Write-Host '   2) 腾讯云控制台 → 防火墙 → 放行 TCP ' -NoNewline
Write-Host $Port -ForegroundColor Yellow
Write-Host '   3) 运行 ' -NoNewline; Write-Host "$AppDir\start.cmd" -ForegroundColor Yellow -NoNewline
Write-Host ' 启动'
Write-Host ''
Write-Host '  访问地址（首次访问会自动写入令牌 Cookie）：' -ForegroundColor White
Write-Host "  http://${ip}:${Port}/app/?token=$token" -ForegroundColor Green
Write-Host "  http://localhost:${Port}/app/?token=$token" -ForegroundColor Green
Write-Host ''
Write-Host "  令牌： $token" -ForegroundColor Yellow
Write-Host '  （也可以在浏览器控制台执行 ' -NoNewline
Write-Host "PF.setToken('$token')" -ForegroundColor Yellow -NoNewline
Write-Host '）'
Write-Host ''
