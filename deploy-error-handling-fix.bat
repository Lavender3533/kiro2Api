@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ═══════════════════════════════════════
echo   部署 Kiro 风格消息历史管理
echo ═══════════════════════════════════════
echo.
echo 服务器: 34.96.206.12
echo 修复文件: src/claude/claude-kiro.js
echo.
echo ✅ 核心功能:
echo.
echo 1️⃣ 自动消息修剪（Kiro 风格）
echo    - 当 token 使用率达到 80%% 时自动触发
echo    - 保留最近 5 条消息的完整内容
echo    - 旧消息截断到前 100 字符
echo    - 多阶段修剪策略（摘要→删除→最终修剪）
echo.
echo 2️⃣ 防止 CONTENT_LENGTH_EXCEEDS_THRESHOLD
echo    - 彻底解决 400 "Input is too long" 错误
echo    - 智能管理上下文窗口（200K tokens）
echo    - 参考 Kiro 官方客户端实现
echo.
echo 3️⃣ 之前的所有优化保留
echo    - 429 限流错误不计入健康检查
echo    - 400 错误详细日志
echo    - 消息格式日志优化
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

echo [1/2] 上传 claude-kiro.js (Kiro 风格消息历史管理)...
scp "D:\project\2api\AIClient-2-API-main\src\claude\claude-kiro.js" root@34.96.206.12:/home/beidezhuanshuxiaomugou/a2a/src/claude/
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 上传 claude-kiro.js 失败
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
echo   ✓ Kiro 风格消息历史管理部署完成!
echo ═══════════════════════════════════════
echo.
echo 预期效果:
echo.
echo ✅ 自动消息修剪
echo    - 当 token 使用率 ^>80%% 时自动触发
echo    - 日志: "[Kiro Auto-Pruning] Token usage: X/200000"
echo    - 日志: "[Kiro Pruning] After summarizing old messages: Y messages"
echo.
echo ✅ 防止 400 "Input is too long" 错误
echo    - 不再出现 CONTENT_LENGTH_EXCEEDS_THRESHOLD 错误
echo    - 长对话可以正常进行
echo    - 保留最近 5 条消息的完整内容
echo.
echo ✅ 所有 provider 可以保持健康
echo    - 不会因为对话太长全部标记为 unhealthy
echo    - 429 限流错误不计入（之前已修复）
echo.
echo 测试地址: http://34.96.206.12:8045
echo 查看日志: ssh root@34.96.206.12 "pm2 logs kiro2api --lines 50"
echo.
echo 💡 测试建议:
echo    1. 发送一个包含 20+ 轮对话的长请求
echo    2. 观察是否触发自动修剪
echo    3. 验证不再出现 400 "Input is too long" 错误
echo.
pause
