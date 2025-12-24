# Kiro Protocol Handler - 拦截 kiro:// 协议并发送到后端
# 使用方法: 先运行 register-kiro-protocol.ps1 注册协议

param(
    [string]$Url
)

# 配置
$BackendUrl = "http://127.0.0.1:23456"  # 修改为你的后端地址

# 日志函数
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] $Message"
}

Write-Log "Kiro Protocol Handler started"
Write-Log "Received URL: $Url"

# 解析 URL
if ($Url -match "code=([^&]+)") {
    $code = $matches[1]
    Write-Log "Extracted code: $($code.Substring(0, [Math]::Min(10, $code.Length)))..."
} else {
    Write-Log "ERROR: No code found in URL"
    Read-Host "Press Enter to exit"
    exit 1
}

if ($Url -match "state=([^&]+)") {
    $state = $matches[1]
    Write-Log "Extracted state: $($state.Substring(0, [Math]::Min(10, $state.Length)))..."
} else {
    Write-Log "ERROR: No state found in URL"
    Read-Host "Press Enter to exit"
    exit 1
}

# 发送到后端
Write-Log "Sending to backend: $BackendUrl/api/kiro/oauth/callback"

try {
    $body = @{
        callback_url = $Url
    } | ConvertTo-Json

    $response = Invoke-RestMethod -Uri "$BackendUrl/api/kiro/oauth/callback" -Method POST -Body $body -ContentType "application/json" -ErrorAction Stop

    if ($response.success) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Green
        Write-Host "          授权成功!" -ForegroundColor Green
        Write-Host "========================================" -ForegroundColor Green
        Write-Host ""
        Write-Host "账号编号: #$($response.accountNumber)" -ForegroundColor Cyan
        Write-Host "Token文件: $($response.tokenFile)" -ForegroundColor Cyan
        Write-Host ""
        Write-Log "Authorization successful!"
    } else {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Red
        Write-Host "          授权失败" -ForegroundColor Red
        Write-Host "========================================" -ForegroundColor Red
        Write-Host ""
        Write-Host "错误: $($response.error)" -ForegroundColor Red
        Write-Log "Authorization failed: $($response.error)"
    }
} catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "          请求失败" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "错误: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "请确保后端服务正在运行: $BackendUrl" -ForegroundColor Yellow
    Write-Log "Request failed: $_"
}

Write-Host ""
Read-Host "Press Enter to close"
