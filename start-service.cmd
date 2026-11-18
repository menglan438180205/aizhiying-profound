@echo off
rem ==========================================================
rem  AI Zhiying BFF - persistent launcher
rem  Used by Windows Task Scheduler (logon trigger) so the
rem  service survives closing WorkBuddy / the AI session.
rem
rem  Manual use: double-click this file.
rem  Stop:       node start-local.js --stop   (or close window)
rem ==========================================================
setlocal
cd /d "%~dp0"

rem --- guard: already listening on 8787 -> do nothing ---
netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [skip] port 8787 already in use, service assumed running
  exit /b 0
)

if not exist ".data" mkdir ".data"
echo. >> ".data\service.log"
echo [start] %date% %time% >> ".data\service.log"

node start-local.js >> ".data\service.log" 2>&1
