# Kiro OAuth Session 清理工具 (PowerShell 版本)
# 使用方法：复制授权链接后运行此脚本

param(
    [string]$AuthUrl = ""
)

Write-Host ""
Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Kiro OAuth Session 清理工具" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# 如果没有提供 URL，从剪贴板获取
if ([string]::IsNullOrEmpty($AuthUrl)) {
    $AuthUrl = Get-Clipboard
    if ([string]::IsNullOrEmpty($AuthUrl)) {
        Write-Host "[错误] 剪贴板中没有内容，请先复制授权链接" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit 1
    }
}

Write-Host "[✓] 检测到授权链接: $AuthUrl" -ForegroundColor Green
Write-Host ""

# 清理 Chrome 的 Kiro cookies
$chromePaths = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default",
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1",
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 2"
)

# 检查 Chrome 是否在运行
$chromeProcess = Get-Process -Name "chrome" -ErrorAction SilentlyContinue
if ($chromeProcess) {
    Write-Host "[提示] 检测到 Chrome 正在运行" -ForegroundColor Yellow
    $response = Read-Host "是否关闭所有 Chrome 窗口？(Y/N)"
    if ($response -eq 'Y' -or $response -eq 'y') {
        Write-Host "[执行] 关闭 Chrome..." -ForegroundColor Yellow
        Stop-Process -Name "chrome" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    } else {
        Write-Host "[提示] 请手动关闭 Chrome 后重新运行此脚本" -ForegroundColor Yellow
        Read-Host "按回车键退出"
        exit 0
    }
}

Write-Host "[执行] 清理 Kiro OAuth Session..." -ForegroundColor Yellow

$cleaned = $false

foreach ($profilePath in $chromePaths) {
    if (Test-Path $profilePath) {
        # 清理 Cookies 文件
        $cookiesFile = Join-Path $profilePath "Network\Cookies"
        if (-not (Test-Path $cookiesFile)) {
            $cookiesFile = Join-Path $profilePath "Cookies"
        }

        if (Test-Path $cookiesFile) {
            try {
                # 备份 cookies 文件
                $backupFile = "$cookiesFile.backup"
                Copy-Item $cookiesFile $backupFile -Force

                # 加载 SQLite 相关类型（如果可用）
                Add-Type -Path "System.Data.SQLite.dll" -ErrorAction SilentlyContinue

                # 尝试使用 SQLite 删除特定 cookies
                $connectionString = "Data Source=$cookiesFile;Version=3;"
                $connection = New-Object System.Data.SQLite.SQLiteConnection($connectionString)
                $connection.Open()

                $command = $connection.CreateCommand()
                $command.CommandText = "DELETE FROM cookies WHERE host_key LIKE '%kiro.dev%'"
                $result = $command.ExecuteNonQuery()

                $connection.Close()

                Write-Host "[✓] 已清理 $result 个 Kiro cookies (精确清理)" -ForegroundColor Green
                $cleaned = $true

                # 删除备份
                Remove-Item $backupFile -Force -ErrorAction SilentlyContinue
            } catch {
                # SQLite 方法失败，使用备用方法：直接删除 cookies 文件
                try {
                    Remove-Item $cookiesFile -Force -ErrorAction Stop
                    Write-Host "[✓] 已清理 Chrome cookies 文件" -ForegroundColor Green
                    $cleaned = $true
                } catch {
                    Write-Host "[警告] 无法清理 $cookiesFile : $_" -ForegroundColor Yellow
                }
            }
        }

        # 清理 Session Storage
        $sessionPath = Join-Path $profilePath "Session Storage"
        if (Test-Path $sessionPath) {
            try {
                Remove-Item "$sessionPath\*" -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "[✓] 已清理 Session Storage" -ForegroundColor Green
                $cleaned = $true
            } catch {
                Write-Host "[警告] 无法清理 Session Storage: $_" -ForegroundColor Yellow
            }
        }
    }
}

if (-not $cleaned) {
    Write-Host "[警告] 未能清理任何 cookies，可能需要管理员权限" -ForegroundColor Yellow
    Write-Host "[提示] 建议使用无痕模式打开授权链接" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[✓] Session 清理完成" -ForegroundColor Green
Write-Host ""

# 打开授权链接
Write-Host "[执行] 打开授权链接..." -ForegroundColor Yellow

# 查找 Chrome
$chromePath = @(
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chromePath) {
    Start-Process $chromePath -ArgumentList $AuthUrl
    Write-Host "[✓] 已在 Chrome 中打开授权链接" -ForegroundColor Green
} else {
    # 尝试 Edge
    $edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    if (Test-Path $edgePath) {
        Start-Process $edgePath -ArgumentList $AuthUrl
        Write-Host "[✓] 已在 Edge 中打开授权链接" -ForegroundColor Green
    } else {
        # 使用默认浏览器
        Start-Process $AuthUrl
        Write-Host "[✓] 已在默认浏览器中打开授权链接" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "[✓] 完成！现在您可以使用任意账号登录授权" -ForegroundColor Green
Write-Host ""

Start-Sleep -Seconds 3
