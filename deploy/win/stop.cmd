@echo off
rem 停止 AI 智盈服务端
setlocal
pushd "%~dp0..\.."
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" start-local.js --stop
) else (
  node start-local.js --stop
)
popd
endlocal
