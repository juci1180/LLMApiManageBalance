@echo off
title 重新登录 AI 钱包平台
cd /d "%~dp0"
echo 将弹出浏览器窗口登录 6 个平台，每个平台最多等 10 分钟。
node scripts\wallet-login.mjs
echo.
pause