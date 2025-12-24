@echo off
chcp 65001 >nul
title Kiro2API Server

echo ========================================
echo     Kiro2API Server
echo ========================================
echo.

cd /d "%~dp0"

:: Check if node is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Check if node_modules exists
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install dependencies!
        pause
        exit /b 1
    )
    echo.
)

:: Kill existing process on port 8045
echo [INFO] Checking port 8045...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8045 " ^| findstr "LISTENING"') do (
    echo [INFO] Killing existing process PID: %%a
    taskkill /F /PID %%a >nul 2>nul
)
timeout /t 1 >nul

echo [INFO] Starting server...
echo [INFO] Dashboard: http://localhost:8045
echo [INFO] Press Ctrl+C to stop
echo.
echo ========================================
echo.

:: Start the server with dev config
node --max-old-space-size=120 src/api-server.js --api-key 123456 --host 0.0.0.0 --port 8045 --model-provider claude-kiro-oauth

pause
