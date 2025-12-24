@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: 获取剪贴板中的链接
echo.
echo ═══════════════════════════════════════
echo   Kiro OAuth 无痕模式启动器
echo ═══════════════════════════════════════
echo.
echo [提示] 请先复制授权链接到剪贴板
echo.

:: 从剪贴板获取 URL
powershell -command "Get-Clipboard" > temp_url.txt
set /p AUTH_URL=<temp_url.txt
del temp_url.txt

if "!AUTH_URL!"=="" (
    echo [错误] 剪贴板中没有内容，请先复制授权链接
    pause
    exit /b 1
)

echo [✓] 检测到链接: !AUTH_URL!
echo.

:: 检测浏览器并打开无痕模式
set BROWSER_FOUND=0

:: 尝试 Chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    echo [✓] 使用 Google Chrome 无痕模式
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --incognito "!AUTH_URL!"
    set BROWSER_FOUND=1
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    echo [✓] 使用 Google Chrome 无痕模式
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --incognito "!AUTH_URL!"
    set BROWSER_FOUND=1
)

:: 尝试 Edge（如果没找到 Chrome）
if !BROWSER_FOUND!==0 (
    if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
        echo [✓] 使用 Microsoft Edge 隐私模式
        start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --inprivate "!AUTH_URL!"
        set BROWSER_FOUND=1
    )
)

:: 尝试 Firefox（如果都没找到）
if !BROWSER_FOUND!==0 (
    if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" (
        echo [✓] 使用 Firefox 隐私模式
        start "" "%ProgramFiles%\Mozilla Firefox\firefox.exe" -private-window "!AUTH_URL!"
        set BROWSER_FOUND=1
    )
)

if !BROWSER_FOUND!==0 (
    echo [错误] 未找到浏览器，请手动打开无痕模式
    echo.
    echo 快捷键:
    echo   Chrome/Edge: Ctrl+Shift+N
    echo   Firefox: Ctrl+Shift+P
    pause
    exit /b 1
)

echo.
echo [✓] 无痕窗口已打开
echo [提示] 请在无痕窗口中完成授权
echo.
timeout /t 3 >nul
