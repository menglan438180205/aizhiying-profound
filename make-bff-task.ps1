$ErrorActionPreference = 'Continue'
$node = (Get-Command node).Source
Write-Host "node path: $node"

# remove any prior task with same name
schtasks /delete /tn "aizhiying-bff" /f 2>$null

# create a SYSTEM task that launches BFF detached from any interactive/SSH session, on boot
$tr = "$node C:\aizhiying\start-local.js --daemon"
schtasks /create /tn "aizhiying-bff" /ru SYSTEM /sc onstart /rl HIGHEST /tr "$tr" /f 2>&1

# run now
schtasks /run /tn "aizhiying-bff" 2>&1

Start-Sleep 6
Write-Host "=== health (local) ==="
try { $h = Invoke-RestMethod http://127.0.0.1:8787/v1/health -TimeoutSec 5; "ok=$($h.ok) uptime=$($h.uptime)" } catch { "health fail: $_" }
$pid = (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue).OwningProcess
"8787 listener pid=$pid"
Write-Host "=== task state ==="
schtasks /query /tn "aizhiying-bff" /v /fo LIST 2>&1 | Select-String -Pattern "Status|TaskName|Last Result" | ForEach-Object { $_.Line.Trim() }
