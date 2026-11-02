@echo off
title Deriv Accumulator Bot
echo ============================================
echo   📈 DERIV ACCUMULATOR BOT
echo ============================================
echo.
cd /d "%~dp0"
echo Checking Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js not found! Please install Node.js
  pause
  exit /b
)
echo Installing dependencies...
call npm install --silent
echo.
echo Starting Accumulator Bot on http://localhost:3007
echo Press Ctrl+C to stop.
echo.
node server.js
pause
