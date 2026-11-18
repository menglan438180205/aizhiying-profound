@echo off
setlocal
title AI ZhiYing Local Bridge
cd /d "%~dp0"
set "PORT=8801"
set "MC_DIR=%~dp0data"
if not exist "%MC_DIR%" mkdir "%MC_DIR%"
netstat -ano | findstr /R /C:":8801 .*LISTENING" >nul
if not errorlevel 1 (
  echo [bridge] already running on port 8801.
  timeout /t 2 >nul
  exit /b 0
)
echo ============================================================
echo   AI ZhiYing Local Bridge
echo   Port %PORT%  -  keep this window open
echo ============================================================
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Install Node.js, or edit this file with the full node.exe path.
  pause
  exit /b 1
)
node server.js
echo.
echo [bridge] exited. Press any key to close...
pause >nul
