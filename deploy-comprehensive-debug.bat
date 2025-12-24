@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ═══════════════════════════════════════
echo   部署全面调试版本
echo ═══════════════════════════════════════
echo.
echo 服务器: 34.96.206.12
echo 修复文件: src/claude/claude-kiro.js
echo.
echo 新增调试功能：
echo - 记录所有事件类型
echo - 追踪 toolUse 事件的接收和处理
echo - 追踪 currentToolCall 的创建和状态
echo - 追踪 toolUseInput 的累积过程（前后长度对比）
echo - 追踪所有事件的 toolUseId
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

echo [1/2] 上传全面调试版 claude-kiro.js...
scp "D:\project\2api\AIClient-2-API-main\src\claude\claude-kiro.js" root@34.96.206.12:/home/beidezhuanshuxiaomugou/a2a/src/claude/
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 上传失败
    pause
    exit /b 1
)
echo [✓] claude-kiro.js 上传成功
echo.

echo [2/2] 重启服务...
ssh root@34.96.206.12 "cd /home/beidezhuanshuxiaomugou/a2a && pm2 restart kiro2api"
if %ERRORLEVEL% NEQ 0 (
    echo [警告] 重启服务失败，请手动执行：
    echo ssh root@34.96.206.12
    echo cd /home/beidezhuanshuxiaomugou/a2a
    echo pm2 restart kiro2api
    pause
    exit /b 1
)

echo.
echo ═══════════════════════════════════════
echo   ✓ 全面调试版本部署完成！
echo ═══════════════════════════════════════
echo.
echo 新增调试内容：
echo 1. 所有事件类型记录：查看是否有 toolUse 事件
echo 2. toolUse 事件详细日志：确认 currentToolCall 是否创建
echo 3. toolUseInput 累积日志：查看每次累积前后的长度变化
echo 4. toolUseId 追踪：确认事件的 ID 匹配
echo.
echo 关键问题诊断：
echo - 如果看不到 "⭐ toolUse event received" 日志
echo   说明 toolUse 事件没有到达，currentToolCall 无法创建
echo.
echo - 如果看到 "⚠️ toolUse - condition failed"
echo   说明 tc.name 或 tc.toolUseId 为空
echo.
echo - 如果看到 "⚠️ toolUseInput - skipped"
echo   说明 currentToolCall 不存在或 event.input 为 undefined
echo.
echo 测试地址：http://34.96.206.12:8045
echo 查看日志：ssh root@34.96.206.12 "pm2 logs kiro2api --lines 100"
echo.
pause
