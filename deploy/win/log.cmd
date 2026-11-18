@echo off
rem 实时跟踪服务端日志（Ctrl+C 退出）
setlocal
pushd "%~dp0..\.."
if not exist ".data\server.log" (
  echo 日志还不存在，请先运行 start.cmd
  popd
  endlocal
  pause
  exit /b
)
powershell -NoProfile -Command "Get-Content -Path '.data\server.log' -Wait -Tail 50"
popd
endlocal
