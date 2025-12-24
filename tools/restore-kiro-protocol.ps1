# 恢复 Kiro 原始协议处理程序
# 需要以管理员权限运行

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Restore Kiro Protocol Handler" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 检查是否有管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "需要管理员权限，正在请求提升权限..." -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    exit
}

$regPath = "HKCR:\kiro"

try {
    # 查找最近的备份
    $backups = Get-ChildItem -Path "HKCR:\" -Name | Where-Object { $_ -like "kiro_backup_*" } | Sort-Object -Descending

    if ($backups.Count -gt 0) {
        $latestBackup = $backups[0]
        Write-Host "Found backup: $latestBackup" -ForegroundColor Yellow

        # 删除当前的拦截器
        if (Test-Path $regPath) {
            Remove-Item -Path $regPath -Recurse -Force
        }

        # 恢复备份
        Copy-Item -Path "HKCR:\$latestBackup" -Destination $regPath -Recurse

        # 删除备份
        Remove-Item -Path "HKCR:\$latestBackup" -Recurse -Force

        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "        恢复成功!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "kiro:// 协议已恢复为 Kiro IDE 处理" -ForegroundColor Cyan
    } else {
        Write-Host "No backup found. Removing interceptor..." -ForegroundColor Yellow

        if (Test-Path $regPath) {
            Remove-Item -Path $regPath -Recurse -Force
            Write-Host ""
            Write-Host "Interceptor removed. You may need to reinstall Kiro IDE to restore the protocol." -ForegroundColor Yellow
        } else {
            Write-Host "kiro:// protocol is not registered." -ForegroundColor Gray
        }
    }
} catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "        恢复失败" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误: $_" -ForegroundColor Red
}

Write-Host ""
Read-Host "Press Enter to close"
