@echo off
REM Local BFF only (http://127.0.0.1:8787).
REM The browser bridge is tools\mediacrawler-bridge\start-local.cmd.
title ProFound BFF
node "%~dp0start-local.js"
