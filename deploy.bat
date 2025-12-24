@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ═══════════════════════════════════════
echo   部署自动清除 Session 功能
echo ═══════════════════════════════════════
echo.
echo 服务器: 34.96.206.12
echo 端口: 8045
echo.

:: 检查 scp 命令是否可用
where scp >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未找到 scp 命令
    echo.
    echo 请安装以下工具之一：
    echo 1. Git for Windows (推荐)
    echo 2. OpenSSH Client
    echo 3. 或者使用 WinSCP 手动上传文件
    echo.
    pause
    exit /b 1
)

echo [1/3] 上传 src/ui-manager.js...
scp "D:\project\2api\AIClient-2-API-main\src\ui-manager.js" root@34.96.206.12:/root/a2a/src/
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 上传失败
    pause
    exit /b 1
)
echo [✓] ui-manager.js 上传成功
echo.

echo [2/3] 上传 static/app/event-stream.js...
scp "D:\project\2api\AIClient-2-API-main\static\app\event-stream.js" root@34.96.206.12:/root/a2a/static/app/
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 上传失败
    pause
    exit /b 1
)
echo [✓] event-stream.js 上传成功
echo.

echo [3/3] 重启服务...
ssh root@34.96.206.12 "cd /root/a2a && pm2 restart kiro2api"
if %ERRORLEVEL% NEQ 0 (
    echo [警告] 重启服务失败，请手动执行：
    echo ssh root@34.96.206.12
    echo cd /root/a2a
    echo pm2 restart kiro2api
    pause
    exit /b 1
)

echo.
echo ═══════════════════════════════════════
echo   ✓ 部署完成！
echo ═══════════════════════════════════════
echo.
echo 新功能：OAuth 成功后自动清除 session
echo 测试地址：http://34.96.206.12:8045
echo.
echo 下次授权可直接使用不同账号，无需无痕模式！
echo.
pause
