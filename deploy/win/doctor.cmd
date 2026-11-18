@echo off
rem 环境与配置自检（Node / FFmpeg / 端口 / 危险开关）
setlocal
pushd "%~dp0..\.."
echo ---- 版本 ----
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" -v
) else (
  node -v
)
if exist "C:\ffmpeg\bin\ffmpeg.exe" (
  "C:\ffmpeg\bin\ffmpeg.exe" -hide_banner -version 2>nul | findstr /r "ffmpeg version"
) else (
  echo FFmpeg: 未找到（视频渲染不可用）
)
echo.
echo ---- 预检 ----
if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" server/preflight.js
) else (
  node server/preflight.js
)
echo.
echo ---- 本地连通性 ----
for /f "usebackq tokens=2 delims==" %%P in (`findstr /r "^PORT=" .env.local`) do set PORT=%%P
if "%PORT%"=="" set PORT=8787
curl -s -m 6 -o nul -w "GET /app/  => HTTP %%{http_code}\n" http://127.0.0.1:%PORT%/app/
curl -s -m 6 http://127.0.0.1:%PORT%/v1/health
echo.
popd
endlocal
pause
