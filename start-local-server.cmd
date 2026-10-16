@echo off
REM Starts the BlitzMall local development server (test database, simulated M-Pesa).
REM Then pick "Local Server (Development)" on the app's login screen.
REM Missing backend packages are installed automatically on first run.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed - get it from https://nodejs.org & pause & exit /b 1)
node scripts\dev-server.js %*
pause
