# 注册 Kiro Protocol Handler
# 需要以管理员权限运行

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$handlerPath = Join-Path $scriptPath "kiro-protocol-handler.ps1"

# 检查处理程序是否存在
if (-not (Test-Path $handlerPath)) {
    Write-Host "ERROR: kiro-protocol-handler.ps1 not found at: $handlerPath" -ForegroundColor Red
    exit 1
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Kiro Protocol Handler Registration" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查是否有管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "需要管理员权限，正在请求提升权限..." -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    exit
}

Write-Host "Handler script: $handlerPath" -ForegroundColor Gray
Write-Host ""

# 创建注册表项
$regPath = "HKCR:\kiro"

try {
    # 备份现有的 kiro 协议（如果存在）
    if (Test-Path $regPath) {
        $backup = Get-Date -Format "yyyyMMdd_HHmmss"
        $backupPath = "HKCR:\kiro_backup_$backup"
        Write-Host "Backing up existing kiro protocol to: kiro_backup_$backup" -ForegroundColor Yellow
        Copy-Item -Path $regPath -Destination $backupPath -Recurse -ErrorAction SilentlyContinue
    }

    # 删除现有的 kiro 协议
    if (Test-Path $regPath) {
        Remove-Item -Path $regPath -Recurse -Force
    }

    # 创建新的协议处理程序
    New-Item -Path $regPath -Force | Out-Null
    Set-ItemProperty -Path $regPath -Name "(Default)" -Value "URL:Kiro Protocol (Intercepted)"
    Set-ItemProperty -Path $regPath -Name "URL Protocol" -Value ""

    # 创建 shell\open\command
    New-Item -Path "$regPath\shell\open\command" -Force | Out-Null

    # 设置命令 - 使用 PowerShell 执行脚本
    $command = "powershell.exe -ExecutionPolicy Bypass -File `"$handlerPath`" `"%1`""
    Set-ItemProperty -Path "$regPath\shell\open\command" -Name "(Default)" -Value $command

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "        注册成功!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "kiro:// 协议现在会被拦截并发送到后端" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "测试方法:" -ForegroundColor Yellow
    Write-Host "  1. 在控制台点击 '生成授权' -> 选择 GitHub/Google" -ForegroundColor Gray
    Write-Host "  2. 关闭 '网页模式' 开关" -ForegroundColor Gray
    Write-Host "  3. 在浏览器中打开授权链接" -ForegroundColor Gray
    Write-Host "  4. 完成登录后，会弹出 PowerShell 窗口显示结果" -ForegroundColor Gray
    Write-Host ""

} catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "        注册失败" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host ""
}

Read-Host "Press Enter to close"
