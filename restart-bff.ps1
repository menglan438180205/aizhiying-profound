schtasks /end /tn "aizhiying-bff" 2>$null
Start-Sleep 2
schtasks /run /tn "aizhiying-bff"
Start-Sleep 8
Write-Host "=== health ==="
try { $h = Invoke-RestMethod http://127.0.0.1:8787/v1/health -TimeoutSec 5; "ok=$($h.ok) uptime=$($h.uptime)" } catch { "health fail: $_" }
$bffpid = (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue).OwningProcess
"listener pid=$bffpid"
Write-Host "=== recent err log (tail 8) ==="
if (Test-Path C:\aizhiying\.data\server.err.log) { Get-Content C:\aizhiying\.data\server.err.log -Tail 8 } else { "no err log" }
