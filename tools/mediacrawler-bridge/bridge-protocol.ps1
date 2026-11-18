$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$start = Join-Path $dir 'start-local.cmd'
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList '/c', ('""' + $start + '""') -WorkingDirectory $dir -WindowStyle Minimized
