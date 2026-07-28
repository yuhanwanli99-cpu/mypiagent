#!/usr/bin/env pwsh
<#
.SYNOPSIS
    API Key 安全注入脚本 (PowerShell)
    从环境变量读取 Key，写入 Pi 配置
.DESCRIPTION
    用法:
      $env:ZHIPU_API_KEY = "your-key"
      .\setup-api-keys.ps1
#>
param()

$ErrorActionPreference = "Stop"

$AgentDir = "$env:USERPROFILE\.pi\agent"
$ModelsFile = Join-Path $AgentDir "models.json"
$ExtensionsDir = Join-Path $AgentDir "extensions"

# ── 确保目录存在 ──────────────────────────────────────
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path $ExtensionsDir | Out-Null

$ZhipuKey = $env:ZHIPU_API_KEY ?? ""
$DeepSeekKey = $env:DEEPSEEK_API_KEY ?? ""

if (-not $ZhipuKey -and -not $DeepSeekKey) {
    Write-Host "WARN: No API keys found in environment."
    Write-Host "      Set `$env:ZHIPU_API_KEY and/or `$env:DEEPSEEK_API_KEY before running."
    Write-Host "      models.json left unchanged."
    exit 0
}

# ── 构建或更新 models.json ────────────────────────────
$config = @{ providers = @{} }

if (Test-Path $ModelsFile) {
    Write-Host "INFO: models.json exists, merging API keys..."
    $config = Get-Content $ModelsFile -Raw | ConvertFrom-Json -AsHashtable
}

if ($ZhipuKey) {
    if (-not $config.providers.ContainsKey("zhipu")) {
        $config.providers["zhipu"] = @{
            name    = "ZhipuAI"
            baseUrl = "https://open.bigmodel.cn/api/paas/v4"
            api     = "openai-completions"
            models  = @()
        }
    }
    $config.providers["zhipu"]["apiKey"] = $ZhipuKey

    # v3 硬化（2026-07-29）：确保 glm-4.1v（免费/轻量视觉，Tester-Visual 用）、
    # glm-4.6v、glm-4.7 都存在于 models 列表，幂等追加，不重复
    $existingModels = @($config.providers["zhipu"]["models"])
    $existingIds = @($existingModels | ForEach-Object { $_.id })

    $wantedModels = @(
        @{
            id            = "glm-4.1v"
            name          = "GLM-4.1V"
            reasoning     = $true
            input         = @("text", "image")
            contextWindow = 64000
            maxTokens     = 4096
            compat        = @{ thinkingFormat = "zai" }
            cost          = @{ input = 0; output = 0; cacheRead = 0; cacheWrite = 0 }
        },
        @{
            id            = "glm-4.6v"
            name          = "GLM-4.6V"
            reasoning     = $true
            input         = @("text", "image")
            contextWindow = 128000
            maxTokens     = 4096
            compat        = @{ thinkingFormat = "zai" }
            cost          = @{ input = 0; output = 0; cacheRead = 0; cacheWrite = 0 }
        },
        @{
            id            = "glm-4.7"
            name          = "GLM-4.7"
            reasoning     = $true
            input         = @("text")
            contextWindow = 204800
            maxTokens     = 131072
            compat        = @{ thinkingFormat = "zai" }
            cost          = @{ input = 0; output = 0; cacheRead = 0; cacheWrite = 0 }
        }
    )

    foreach ($m in $wantedModels) {
        if ($existingIds -notcontains $m.id) {
            $existingModels += $m
        }
    }
    $config.providers["zhipu"]["models"] = $existingModels

    $config.providers["zai-coding-cn"] = @{ apiKey = $ZhipuKey }
    Write-Host "OK: Zhipu API Key injected ($($ZhipuKey.Length) chars), models synced (glm-4.1v/4.6v/4.7)"
}

if ($DeepSeekKey) {
    $config.providers["deepseek"] = @{ apiKey = $DeepSeekKey }
    Write-Host "OK: DeepSeek API Key injected ($($DeepSeekKey.Length) chars)"
}

# ── 原子写入 ──────────────────────────────────────────
$json = $config | ConvertTo-Json -Depth 10
$tmpFile = "$ModelsFile.tmp.$PID"
try {
    Set-Content -Path $tmpFile -Value $json -NoNewline -Encoding UTF8
    Move-Item -Path $tmpFile -Destination $ModelsFile -Force
    Write-Host "OK: $ModelsFile written ($(($json | Measure-Object -Character).Characters) bytes)"
} finally {
    Remove-Item -Path $tmpFile -Force -ErrorAction SilentlyContinue
}

# ── 清理旧硬编码 Key 的扩展 ───────────────────────────
$extFile = Join-Path $ExtensionsDir "zhipu-provider.ts"
if (Test-Path $extFile) {
    $content = Get-Content $extFile -Raw
    if ($content -match "apiKey.*[a-f0-9]{32}") {
        Write-Warning "$extFile may contain hardcoded API key. Review and remove it."
    }
}

Write-Host "DONE: API key setup complete."
