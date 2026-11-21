@echo off
rem Close the AI Wallet Balance Monitor service.
rem Keep this file ASCII-only: cmd.exe reads .bat in the console ANSI codepage,
rem and Chinese bytes in a GBK console turn into garbage. All Chinese messages
rem are printed by scripts\stop-server.mjs (Node writes UTF-16 to a real
rem console via WriteConsoleW, so it displays correctly).
title Stop AI Wallet Balance Monitor
cd /d "%~dp0"

node scripts\stop-server.mjs
set "RC=%errorlevel%"

echo.
if "%RC%"=="0" (
  echo Service stopped.
) else (
  echo Could not stop the service completely. See the details above.
)

echo.
pause
