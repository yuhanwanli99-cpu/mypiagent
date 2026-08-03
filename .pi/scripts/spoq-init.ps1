#!/usr/bin/env pwsh
<#
.SYNOPSIS
    SPOQ 流水线一键初始化（v6 全局化版）
.DESCRIPTION
    在目标项目目录下创建最小化的 .pi/ 骨架（spoq-state.json、spoq-mailbox/、
    lessons-learned.md）。角色定义（agent-loops/*.md）和状态机 schema 不需要
    复制进项目——spoq-enforcer.ts（已部署为全局扩展 ~/.pi/agent/extensions/
    spoq-enforcer.ts）在项目本地找不到 .pi/agent-loops/{role}.md 时会自动回退
    读取全局模板 ~/.pi/agent/spoq-templates/agent-loops/{role}.md。

    项目如需要自定义某个角色的行为，只需在本项目 .pi/agent-loops/ 下放一份
    同名 .md 覆盖全局模板即可（本地优先）。
.PARAMETER Path
    目标项目目录，默认当前目录。
.EXAMPLE
    .\spoq-init.ps1 -Path G:\git\some-project
#>
param(
    [string]$Path = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

# 注意：PowerShell 5.1 的 Set-Content -Encoding UTF8 会写入带 BOM 的文件，
# 而 spoq-enforcer.ts 用 JSON.parse 直接解析（Node 的 readFileSync 保留 BOM 字符，
# JSON.parse 会抛异常 → 状态机静默降级为 Phase 0，永远进不了 Phase 2）。
# 因此这里统一用 .NET API 写 UTF-8 无 BOM（PS 5.1 / PS 7 行为一致）。
$Utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false

$projectPi = Join-Path $Path ".pi"
$mailboxDir = Join-Path $projectPi "spoq-mailbox"
$statePath = Join-Path $projectPi "spoq-state.json"
$lessonsPath = Join-Path $projectPi "lessons-learned.md"

New-Item -ItemType Directory -Force -Path $projectPi | Out-Null
New-Item -ItemType Directory -Force -Path $mailboxDir | Out-Null

if (Test-Path $statePath) {
    Write-Host "SKIP: $statePath 已存在，不覆盖。"
} else {
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $state = [ordered]@{
        version     = "1.0"
        phase       = "planning"
        dag         = @{ tasks = @{} }
        currentWave = -1
        totalWaves  = 0
        lessons     = @()
        createdAt   = $now
        updatedAt   = $now
    }
    [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10), $Utf8NoBom)
    Write-Host "OK: $statePath 已创建（phase=planning，等待 Phase 1 规划完成后写入 dag/currentWave）"
}

if (Test-Path $lessonsPath) {
    Write-Host "SKIP: $lessonsPath 已存在，不覆盖。"
} else {
    $lessonsContent = @"
# Lessons Learned

本文件由 SPOQ Orchestrator 在每个 Wave 结束后追加教训条目。
格式：`- **日期**: YYYY-MM-DD [Wave N][task-id] {类别} 教训：... 标准：... 建议：...`
"@
    [System.IO.File]::WriteAllText($lessonsPath, $lessonsContent, $Utf8NoBom)
    Write-Host "OK: $lessonsPath 已创建"
}

Write-Host ""
Write-Host "DONE: SPOQ 骨架已就绪于 $projectPi"
Write-Host "角色定义 / 状态机 schema 使用全局模板：$env:USERPROFILE\.pi\agent\spoq-templates\"
Write-Host "如需为本项目定制角色行为，在 $projectPi\agent-loops\{role}.md 放同名文件即可覆盖全局模板。"
Write-Host "下一步：在本项目发起 Phase 0/1 对话，让 Orchestrator 做需求拆解并写入 $statePath"
