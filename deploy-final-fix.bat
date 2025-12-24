@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ═══════════════════════════════════════
echo   部署最终修复版本
echo ═══════════════════════════════════════
echo.
echo 服务器: 34.96.206.12
echo 修复文件: src/claude/claude-kiro.js
echo.
echo ⚠️ CRITICAL FIX:
echo - 修复重复 toolUse 事件导致 input 被清空的问题
echo - Kiro API 会反复发送相同的 toolUse 事件
echo - 现在检查 toolUseId,只在首次创建 currentToolCall
echo - 重复的 toolUse 事件会被忽略,input 继续累积
echo.

:: 检查 scp 命令是否可用
where scp >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未找到 scp 命令
    echo.
    echo 请安装以下工具之一:
    echo 1. Git for Windows (推荐)
    echo 2. OpenSSH Client
    echo 3. 或者使用 WinSCP 手动上传文件
    echo.
    pause
    exit /b 1
)

echo [1/2] 上传最终修复版 claude-kiro.js...
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
    echo [警告] 重启服务失败,请手动执行:
    echo ssh root@34.96.206.12
    echo cd /home/beidezhuanshuxiaomugou/a2a
    echo pm2 restart kiro2api
    pause
    exit /b 1
)

echo.
echo ═══════════════════════════════════════
echo   ✓ 最终修复版本部署完成!
echo ═══════════════════════════════════════
echo.
echo 修复内容:
echo 1. 检查重复的 toolUse 事件 (相同 toolUseId)
echo 2. 重复事件直接跳过,不重新创建 currentToolCall
echo 3. input 正常累积,不会被清空
echo.
echo 预期效果:
echo - 应该能看到 "duplicate event for same toolUseId" 日志
echo - toolUseInput 累积长度应该持续增长
echo - toolUseStop 时 input length 应该是完整的 JSON 长度
echo - JSON 解析应该成功
echo - 工具调用应该正常工作!
echo.
echo 测试地址: http://34.96.206.12:8045
echo 查看日志: ssh root@34.96.206.12 "pm2 logs kiro2api --lines 50"
echo.
pause
