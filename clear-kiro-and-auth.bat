@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: 清除 Kiro OAuth Session 并打开授权链接
echo.
echo ═══════════════════════════════════════
echo   Kiro OAuth 自动清理工具
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

echo [✓] 检测到授权链接
echo.

:: 查找 Chrome 用户数据目录
set CHROME_USER_DATA=%LOCALAPPDATA%\Google\Chrome\User Data
set CHROME_DEFAULT_PROFILE=%CHROME_USER_DATA%\Default
set CHROME_COOKIES=%CHROME_DEFAULT_PROFILE%\Cookies
set CHROME_NETWORK_COOKIES=%CHROME_DEFAULT_PROFILE%\Network\Cookies

:: 检查 Chrome 是否正在运行
tasklist /FI "IMAGENAME eq chrome.exe" 2>NUL | find /I /N "chrome.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo [提示] 检测到 Chrome 正在运行，需要关闭才能清理 cookies
    echo.
    choice /C YN /M "是否关闭所有 Chrome 窗口并继续"
    if errorlevel 2 (
        echo [取消] 用户取消操作
        pause
        exit /b 1
    )
    echo.
    echo [执行] 关闭 Chrome...
    taskkill /F /IM chrome.exe >nul 2>&1
    timeout /t 2 >nul
)

:: 使用 sqlite3 清理 Kiro 相关 cookies
echo [执行] 清理 Kiro OAuth cookies...

:: 检查是否有 sqlite3.exe
where sqlite3.exe >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [警告] 未找到 sqlite3.exe，尝试使用备用方法...

    :: 备用方法：直接删除整个 Cookies 文件（会清除所有 cookies，但最有效）
    if exist "%CHROME_COOKIES%" (
        del /F /Q "%CHROME_COOKIES%" >nul 2>&1
        echo [✓] 已清理 Chrome cookies 文件
    )
    if exist "%CHROME_NETWORK_COOKIES%" (
        del /F /Q "%CHROME_NETWORK_COOKIES%" >nul 2>&1
        echo [✓] 已清理 Chrome Network cookies 文件
    )
) else (
    :: 使用 sqlite3 精确删除 kiro.dev 域名的 cookies
    if exist "%CHROME_COOKIES%" (
        sqlite3.exe "%CHROME_COOKIES%" "DELETE FROM cookies WHERE host_key LIKE '%%kiro.dev%%';" >nul 2>&1
        echo [✓] 已清理 Kiro cookies (主文件)
    )
    if exist "%CHROME_NETWORK_COOKIES%" (
        sqlite3.exe "%CHROME_NETWORK_COOKIES%" "DELETE FROM cookies WHERE host_key LIKE '%%kiro.dev%%';" >nul 2>&1
        echo [✓] 已清理 Kiro cookies (Network)
    )
)

echo.
echo [✓] Kiro session 已清理完成
echo.

:: 检测浏览器并打开授权链接
set BROWSER_FOUND=0

:: 尝试 Chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    echo [✓] 使用 Google Chrome 打开授权链接
    start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "!AUTH_URL!"
    set BROWSER_FOUND=1
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    echo [✓] 使用 Google Chrome 打开授权链接
    start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "!AUTH_URL!"
    set BROWSER_FOUND=1
)

:: 尝试 Edge（如果没找到 Chrome）
if !BROWSER_FOUND!==0 (
    if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
        echo [✓] 使用 Microsoft Edge 打开授权链接
        start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "!AUTH_URL!"
        set BROWSER_FOUND=1
    )
)

if !BROWSER_FOUND!==0 (
    echo [错误] 未找到浏览器
    pause
    exit /b 1
)

echo.
echo [✓] 授权链接已打开
echo [提示] 现在您可以使用任意账号登录授权
echo.
timeout /t 3 >nul
