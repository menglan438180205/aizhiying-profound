@echo off
setlocal
cd /d "%~dp0"
echo Starting local bridge...
start "" "aizhiying://start"
timeout /t 2 /nobreak >nul
echo Opening latest app...
start "" "https://aizhiying.online/app/"
echo If the browser asks to open aizhiying://, choose Allow.
endlocal
