@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ═══════════════════════════════════════
echo   终极修复版本（Ultimate Fix）
echo ═══════════════════════════════════════
echo.
echo 服务器: 34.96.206.12
echo 修复文件: src/claude/claude-kiro.js
echo.
echo ✅ 完美复刻官方 Kiro 客户端逻辑:
echo.
echo 1️⃣ 事件解析优化（parseAwsEventStreamBuffer）
echo    - 每个 toolUseEvent 解析成完整事件
echo    - 包含 name, toolUseId, input, stop
echo    - 不再拆分成多个小事件
echo.
echo 2️⃣ 事件处理优化（generateContentStream）
echo    - 使用全局 Set 追踪所有 toolUseId
echo    - 第一次：创建 currentToolCall，设置 id/name
echo    - 每次：累积 input（无论是否第一次）
echo    - stop 标志：保存 currentToolCall
echo    - 完全匹配 extension.js:708085-708123
echo.
echo 3️⃣ HTML 转义优化（unescapeHTML）
echo    - 支持官方的所有转义格式
echo    - 十进制：&#38; &#60; &#62; &#39; &#34;
echo    - 十六进制：&#x27; &#x60; &#x2F; &#x5C;
echo    - 命名实体：&amp; &lt; &gt; &apos; &quot;
echo.
echo 参考官方 Kiro 源码:
echo - extension.js:708085-708123 (工具调用逻辑)
echo - extension.js:578020-578035 (HTML 转义)
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

echo [1/2] 上传终极修复版 claude-kiro.js...
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
echo   ✓ 终极修复版本部署完成！
echo ═══════════════════════════════════════
echo.
echo 核心改进总结:
echo.
echo 🎯 事件解析层（1944-1961行）
echo    - 统一解析：每个 toolUseEvent → 一个完整的 toolUse 事件
echo    - 包含所有字段：name, toolUseId, input, stop
echo.
echo 🎯 事件处理层（2546-2605行）
echo    - 全局 Set：const seenToolUseIds = new Set()
echo    - 第一次：if (!seenToolUseIds.has(id)) { 创建 + 设置 name/id }
echo    - 每次：累积 input（无论是否重复）
echo    - stop：保存 currentToolCall
echo.
echo 🎯 HTML 转义（46-71行）
echo    - 支持十进制、十六进制、命名实体
echo    - 覆盖官方 Kiro 所有转义格式
echo.
echo 预期日志输出:
echo - "first time seeing toolUseId xxx, added to Set (total: N)"
echo - "duplicate toolUseId xxx, only accumulating input"
echo - "accumulated input: X -> Y (added Z chars)"
echo - "stop flag detected, finalizing tool call (input length: N)"
echo - "JSON parse success"
echo.
echo 测试地址: http://34.96.206.12:8045
echo 查看日志: ssh root@34.96.206.12 "pm2 logs kiro2api --lines 100"
echo.
echo 💡 这次是完美复刻官方 Kiro 的逻辑，应该彻底解决问题了！
echo.
pause
