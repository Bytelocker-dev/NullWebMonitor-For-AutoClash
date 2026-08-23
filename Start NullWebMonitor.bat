@echo off
title NullWebMonitor for AutoClash
cd /d "%~dp0"
echo.
echo   NullWebMonitor for AutoClash
echo   ----------------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js was not found.
  echo   Attempting automatic installation ^(winget^)...
  echo.
  where winget >nul 2>&1
  if errorlevel 1 (
    echo   Node.js was not found.
    echo.
    echo   Install it from https://nodejs.org  ^(the LTS version is fine^),
    echo   then run this file again.
    echo.
    pause
    exit /b 1
  )
  winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo.
    echo   Installation failed. Please install Node.js manually:
    echo   https://nodejs.org
    pause
    exit /b 1
  )
  echo.
  echo   Node.js was installed.
  echo   Please close this window and run the file again
  echo   so the PATH change takes effect.
  echo.
  pause
  exit /b 0
)

if not exist "node_modules\ws" (
  echo   First run - installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo.
)
if not exist ".env" (
  echo   No configuration yet.
  echo   A setup wizard will open in your browser - create a password there.
  echo.
)
echo   Starting... the panel will open automatically.
echo   Keep this window open. Close it to stop the monitor.
echo.
REM Give the server a moment to bind before the browser opens.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8477"
:loop
node bot.js
echo.
echo   Monitor stopped. Restarting in 5 seconds...
echo   Press Ctrl+C or close this window to quit.
timeout /t 5 /nobreak >nul
goto loop
