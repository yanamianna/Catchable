@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 22.13 or newer first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 exit /b 1
)
call npm.cmd run build
if errorlevel 1 (
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4174/ in your browser. Keep this window open.
call npm.cmd start
pause
