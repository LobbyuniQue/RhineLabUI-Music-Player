@echo off
rem Unified launcher: web UI, VLC bridge, and browser.
rem Usage: start this file or pass a music directory: "D:\Music"
cd /d "%~dp0"
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
call node scripts\start-rhine.mjs %*
if errorlevel 1 (pause & exit /b 1)
