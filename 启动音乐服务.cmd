@echo off
rem Compatibility entry: VLC bridge only; no web UI.
rem Usage: start this file or pass a music directory: "D:\Music"
cd /d "%~dp0"
if not exist node_modules (
  call npm ci
  if errorlevel 1 exit /b 1
)
call node scripts\start-rhine.mjs --bridge-only %*
if errorlevel 1 pause
