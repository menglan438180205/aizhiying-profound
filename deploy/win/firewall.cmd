@echo off
rem 在 Windows 防火墙放行应用端口（需要管理员权限）
setlocal
pushd "%~dp0..\.."
for /f "usebackq tokens=2 delims==" %%P in (`findstr /r "^PORT=" .env.local`) do set PORT=%%P
if "%PORT%"=="" set PORT=8787
netsh advfirewall firewall add rule name="AIZhiYing-%PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul
echo 已放行 TCP %PORT%
echo.
echo 注意：腾讯云控制台「防火墙」里也要放行 TCP %PORT%，否则公网仍然连不上。
popd
endlocal
pause
