@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ═══════════════════════════════════════
echo   部署完美复刻版（Perfect Replication）
echo ═══════════════════════════════════════
echo.
echo 服务器: 34.96.206.12
echo 修复文件: src/claude/claude-kiro.js
echo.
echo ✅ 完美复刻官方 Kiro 客户端逻辑:
echo - 使用全局 Set 追踪所有 toolUseId (seenToolUseIds)
echo - 参考: extension.js 行708091-708092
echo - 只在首次遇到 toolUseId 时创建 currentToolCall
echo - 正确处理并发工具调用 (A→B→A 场景)
echo - 彻底解决 input 被清空的问题
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

echo [1/2] 上传完美复刻版 claude-kiro.js...
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
echo   ✓ 完美复刻版部署完成!
echo ═══════════════════════════════════════
echo.
echo 核心改进（完美复刻官方逻辑）:
echo.
echo 1️⃣ 全局 Set 追踪
echo    const seenToolUseIds = new Set();
echo    if (seenToolUseIds.has(tc.toolUseId)) { skip }
echo.
echo 2️⃣ 官方模式匹配
echo    参考: extension.js:708091
echo    if (!toolCalls.has(toolUseId)) {
echo        toolCalls.add(toolUseId);
echo    }
echo.
echo 3️⃣ 并发场景支持
echo    A→B→A 多工具交错调用
echo    全局追踪确保每个 ID 只创建一次
echo.
echo 预期日志输出:
echo - "first time seeing toolUseId xxx, added to Set (total: N)"
echo - "duplicate event (global Set check) for toolUseId xxx"
echo - toolUseInput 累积长度持续增长
echo - toolUseStop 时 input 是完整的 JSON
echo - JSON 解析成功，工具正常执行
echo.
echo 测试地址: http://34.96.206.12:8045
echo 查看日志: ssh root@34.96.206.12 "pm2 logs kiro2api --lines 100"
echo.
echo 💡 这次应该彻底解决问题了！
echo.
pause
