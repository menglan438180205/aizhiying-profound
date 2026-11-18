#requires -RunAsAdministrator
<#
  recover-production.ps1
  在 Windows Server 上以管理员身份运行：
    powershell -ExecutionPolicy Bypass -File C:\aizhiying\deploy\win\recover-production.ps1

  作用：
  1. 启动 BFF 计划任务（aizhiying-bff / AIZhiYing-BFF）
  2. 启动 cloudflared 服务或计划任务
  3. 检查本机 8787 与公网域名
  4. 打印 cloudflared 手工启动指引（如果既没有服务也没有任务）
#>

$ErrorActionPreference = 'Continue'
$app = 'C:\aizhiying'
$port = 8787
$domain = 'https://www.aizhiying.online'

function Say($m) { Write-Host "[recover] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[recover] $m" -ForegroundColor Yellow }
function Ok($m) { Write-Host "[recover] $m" -ForegroundColor Green }

function Test-LocalHealth {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/v1/health" -TimeoutSec 6
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Test-PublicHealth {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "$domain/v1/health" -TimeoutSec 12
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

Say "1. 启动 BFF"
$taskNames = @('aizhiying-bff', 'AIZhiYing-BFF')
$started = $false
foreach ($name in $taskNames) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) {
    Say "找到计划任务 $name，尝试启动"
    Start-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    $started = $true
    break
  }
}
if (-not $started) {
  $cmd = Join-Path $app 'start-bff.cmd'
  if (Test-Path $cmd) {
    Say "未找到计划任务，直接运行 $cmd"
    Start-Process -FilePath $cmd -WorkingDirectory $app -WindowStyle Minimized
    $started = $true
  } else {
    Warn "没有找到 aizhiying-bff 计划任务，也没有 $cmd"
  }
}
Start-Sleep -Seconds 4
if (Test-LocalHealth) { Ok "本机 BFF 已恢复：http://127.0.0.1:$port/v1/health" }
else { Warn "本机 BFF 仍未起来，查看 C:\aizhiying\.data\server.log / server.err.log" }

Say "2. 启动 cloudflared"
$svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
if (-not $svc) { $svc = Get-Service | Where-Object { $_.Name -match 'cloudflared' } | Select-Object -First 1 }
if ($svc) {
  Say "找到服务 $($svc.Name)，当前状态 $($svc.Status)"
  if ($svc.Status -ne 'Running') {
    try { Start-Service $svc.Name; Ok "服务已启动" } catch { Warn "服务启动失败：$($_.Exception.Message)" }
  } else { Ok "服务已在运行" }
} else {
  $ct = Get-ScheduledTask | Where-Object { $_.TaskName -match 'cloudflared|tunnel' } | Select-Object -First 1
  if ($ct) {
    Say "找到计划任务 $($ct.TaskName)，尝试启动"
    Start-ScheduledTask -TaskName $ct.TaskName -ErrorAction SilentlyContinue
  } else {
    Warn "没有找到 cloudflared 服务/计划任务，需要手工启动："
    Write-Host '  cloudflared tunnel list'
    Write-Host '  cloudflared tunnel run <你的隧道名>'
    Write-Host '  配置文件通常在:'
    Write-Host '    C:\Users\Administrator\.cloudflared\config.yml'
    Write-Host '    C:\Windows\System32\config\systemprofile\.cloudflared\config.yml'
  }
}

Say "3. 检查 SSH（可选）"
$ssh = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
if ($ssh) {
  if ($ssh.Status -ne 'Running') { try { Start-Service sshd; Ok "sshd 已启动" } catch { Warn "sshd 启动失败" } }
  else { Ok "sshd 已在运行" }
} else { Warn "未安装 sshd，不影响网站" }

Start-Sleep -Seconds 3
Say "4. 验证"
if (Test-LocalHealth) { Ok "本地 health 200" } else { Warn "本地 health 失败" }
if (Test-PublicHealth) { Ok "公网 health 200：$domain" } else { Warn "公网仍然失败：检查 Cloudflare Tunnel 是否已连接" }

Write-Host ''
Write-Host '如果公网仍失败：' -ForegroundColor Yellow
Write-Host '  1) 打开 Cloudflare Zero Trust → Networks → Tunnels，确认隧道状态为 Healthy'
Write-Host '  2) 确认隧道 public hostname 指向 http://127.0.0.1:8787'
Write-Host '  3) 在服务器上确认 cloudflared 进程存在：Get-Process cloudflared'
