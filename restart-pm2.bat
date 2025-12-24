@echo off
chcp 65001 >nul
cls

echo ========================================
echo    Kiro2API PM2 重启脚本
echo ========================================
echo.

REM 检查是否在运行
pm2 list | findstr "kiro2api" >nul 2>nul
if %errorlevel% equ 0 (
    echo [信息] 正在重启 kiro2api 服务...
    pm2 restart kiro2api
    if %errorlevel% equ 0 (
        echo [成功] 服务重启成功
    ) else (
        echo [错误] 服务重启失败
        pause
        exit /b 1
    )
) else (
    echo [信息] kiro2api 服务未在运行，正在启动...
    pm2 start ecosystem.config.cjs
    if %errorlevel% equ 0 (
        echo [成功] 服务启动成功
    ) else (
        echo [错误] 服务启动失败
        pause
        exit /b 1
    )
)

pm2 save
echo.
pm2 status

pause
