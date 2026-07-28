#!/usr/bin/env pwsh
# ─────────────────────────────────────────────────────
# atomic-write.ps1 — 原子写入脚本 (PowerShell)
# 用法: .\atomic-write.ps1 -Target <file> -Content <json-string>
#       or pipe: '{}' | .\atomic-write.ps1 -Target target.json
# ─────────────────────────────────────────────────────
param(
    [Parameter(Mandatory=$true)]
    [string]$Target,

    [Parameter(ValueFromPipeline=$true)]
    [string]$Content
)

$ErrorActionPreference = "Stop"

# ── 从 stdin 读取（优先）──────────────────────────────
if (-not $Content) {
    $Content = $input | Out-String
}

if (-not $Content -or $Content.Trim().Length -eq 0) {
    Write-Error "No content provided."
    exit 1
}

# ── JSON 语法校验 ──────────────────────────────────────
try {
    $null = $Content | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Error "Invalid JSON content: $_"
    exit 1
}

# ── 写入临时文件 ───────────────────────────────────────
$Tmp = "$Target.tmp.$PID"
$Timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$Backup = "$Target.backup.$Timestamp"

# ── 如果目标文件存在，先备份 ──────────────────────────
if (Test-Path $Target) {
    try {
        Copy-Item $Target $Backup -Force
    } catch {
        Write-Warning "Cannot backup $Target : $_"
    }
}

# ── 原子写入 (PowerShell 默认不保证原子, 用 try/finally) ──
try {
    Set-Content -Path $Tmp -Value $Content -NoNewline -Encoding UTF8
    Move-Item -Path $Tmp -Destination $Target -Force
    Write-Host "OK: $Target written atomically. Backup: $Backup"
} catch {
    Write-Error "Write failed: $_"
    Remove-Item -Path $Tmp -Force -ErrorAction SilentlyContinue
    exit 1
}
