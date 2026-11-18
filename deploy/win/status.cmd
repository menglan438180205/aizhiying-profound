@echo off
rem 查看服务状态、端口与访问地址
setlocal
pushd "%~dp0..\.."
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" start-local.js --status
) else (
  node start-local.js --status
)
echo.
echo ---- 端口占用 ----
netstat -ano | findstr LISTENING | findstr ":8787"
popd
endlocal
pause
