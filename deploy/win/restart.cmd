@echo off
rem 重启 AI 智盈服务端
setlocal
pushd "%~dp0..\.."
if exist "C:\Program Files\nodejs\node.exe" (
  set "NODE=C:\Program Files\nodejs\node.exe"
) else (
  set "NODE=node"
)
"%NODE%" start-local.js --stop
timeout /t 2 /nobreak >nul
"%NODE%" start-local.js --daemon
popd
endlocal
