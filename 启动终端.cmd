@echo off
rem Compatibility entry: web UI only; no VLC bridge.
cd /d "%~dp0"
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
call node scripts\start-rhine.mjs --no-music %*
if errorlevel 1 (pause & exit /b 1)
