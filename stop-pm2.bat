@echo off
chcp 65001 >nul
cls

echo ========================================
echo    Kiro2API PM2 停止脚本
echo ========================================
echo.

REM 检查是否在运行
pm2 list | findstr "kiro2api" >nul 2>nul
if %errorlevel% equ 0 (
    echo [信息] 正在停止 kiro2api 服务...
    pm2 stop kiro2api
    if %errorlevel% equ 0 (
        echo [成功] 服务已停止
    ) else (
        echo [错误] 服务停止失败
        pause
        exit /b 1
    )

    REM 询问是否删除
    set /p delete="是否同时删除服务? (y/n): "
    if /i "%delete%"=="y" (
        pm2 delete kiro2api
        echo [成功] 服务已删除
        pm2 save
    )
) else (
    echo [信息] kiro2api 服务未在运行
)

echo.
pm2 status

pause
