$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $dir 'start-local.cmd'
$protocol = Join-Path $dir 'bridge-protocol.ps1'
if (-not (Test-Path $start)) {
  Write-Host 'start-local.cmd not found next to this installer.'
  exit 1
}

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'AIZhiYing Local Bridge.lnk'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
$lnk.Arguments = '/c ""' + $start + '""'
$lnk.WorkingDirectory = $dir
$lnk.WindowStyle = 7
$lnk.Description = 'AI ZhiYing local bridge'
$lnk.Save()

$key = 'HKCU:\Software\Classes\aizhiying'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:AI ZhiYing Local Bridge'
$cmdKey = Join-Path $key 'shell\open\command'
New-Item -Path $cmdKey -Force | Out-Null
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$cmd = '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $protocol + '" "%1"'
Set-ItemProperty -Path $cmdKey -Name '(default)' -Value $cmd

Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList '/c', ('""' + $start + '""') -WorkingDirectory $dir -WindowStyle Minimized
Write-Host 'Installed. The bridge is starting minimized.'
Write-Host ('Startup shortcut: ' + $lnkPath)
Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8801/v1/ping' -TimeoutSec 6
  Write-Host ('Bridge OK: HTTP ' + $r.StatusCode)
} catch {
  Write-Host ('Bridge check failed: ' + $_.Exception.Message)
}
