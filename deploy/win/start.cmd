@echo off
rem 启动 AI 智盈服务端（后台常驻，不随窗口关闭退出）
setlocal
pushd "%~dp0..\.."
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" start-local.js --daemon
) else (
  node start-local.js --daemon
)
popd
endlocal
