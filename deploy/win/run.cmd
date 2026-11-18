@echo off
rem 前台运行（调试用：日志直接打在窗口，Ctrl+C 停止）
setlocal
pushd "%~dp0..\.."
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" start-local.js
) else (
  node start-local.js
)
popd
endlocal
pause
