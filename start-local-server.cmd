@echo off
REM Starts the BlitzMall local development server (test database, simulated M-Pesa).
REM Then pick "Local Server (Development)" on the app's login screen.
cd /d "%~dp0"
if not exist "node_modules\express\package.json" (
  echo Installing backend packages, one time only...
  call npm install --no-audit --no-fund || goto :fail
)
node scripts\dev-server.js %*
goto :end
:fail
echo Could not install packages. Is Node.js installed?
:end
pause
