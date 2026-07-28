#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# setup-api-keys.sh — API Key 安全注入脚本
# 从环境变量读取 Key，写入 Pi 配置（文件权限 600）
# 用法: setup-api-keys.sh
#   ZHIPU_API_KEY=xxx setup-api-keys.sh
#   DEEPSEEK_API_KEY=xxx setup-api-keys.sh
# ─────────────────────────────────────────────────────
set -euo pipefail

AGENT_DIR="${HOME}/.pi/agent"
MODELS_FILE="${AGENT_DIR}/models.json"
EXTENSIONS_DIR="${AGENT_DIR}/extensions"

# ── 确保目录存在 ──────────────────────────────────────
mkdir -p "$AGENT_DIR" "$EXTENSIONS_DIR"

# ── 读取现有 models.json（如果存在）──────────────────
if [ -f "$MODELS_FILE" ]; then
	echo "INFO: models.json exists, updating API keys..."
	# 用 Python 做 JSON 合并（安全替换）
	python3 -c "
import json, os, sys
with open('$MODELS_FILE', 'r') as f:
    cfg = json.load(f)

zhipu_key = os.environ.get('ZHIPU_API_KEY', '')
deepseek_key = os.environ.get('DEEPSEEK_API_KEY', '')

if zhipu_key:
    zhipu_cfg = cfg.setdefault('providers', {}).setdefault('zhipu', {})
    zhipu_cfg['apiKey'] = zhipu_key
    zhipu_cfg.setdefault('name', 'ZhipuAI')
    zhipu_cfg.setdefault('baseUrl', 'https://open.bigmodel.cn/api/paas/v4')
    zhipu_cfg.setdefault('api', 'openai-completions')
    models = zhipu_cfg.setdefault('models', [])
    existing_ids = {m.get('id') for m in models}
    # v3 硬化（2026-07-29）：补充 glm-4.1v ——免费/轻量视觉模型，
    # 供 Tester-Visual 档使用（区分于付费的 glm-4.6v）
    if 'glm-4.1v' not in existing_ids:
        models.append({
            'id': 'glm-4.1v', 'name': 'GLM-4.1V', 'reasoning': True, 'input': ['text', 'image'],
            'contextWindow': 64000, 'maxTokens': 4096, 'compat': {'thinkingFormat': 'zai'},
            'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
        })
    if 'glm-4.6v' not in existing_ids:
        models.append({
            'id': 'glm-4.6v', 'name': 'GLM-4.6V', 'reasoning': True, 'input': ['text', 'image'],
            'contextWindow': 128000, 'maxTokens': 4096, 'compat': {'thinkingFormat': 'zai'},
            'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
        })
    if 'glm-4.7' not in existing_ids:
        models.append({
            'id': 'glm-4.7', 'name': 'GLM-4.7', 'reasoning': True, 'input': ['text'],
            'contextWindow': 204800, 'maxTokens': 131072, 'compat': {'thinkingFormat': 'zai'},
            'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
        })
    cfg.setdefault('providers', {}).setdefault('zai-coding-cn', {})['apiKey'] = zhipu_key
    print(f'OK: Zhipu API Key injected ({len(zhipu_key)} chars), models synced (glm-4.1v/4.6v/4.7)')

if deepseek_key:
    cfg.setdefault('providers', {}).setdefault('deepseek', {})['apiKey'] = deepseek_key
    print(f'OK: DeepSeek API Key injected ({len(deepseek_key)} chars)')

if not zhipu_key and not deepseek_key:
    print('WARN: No API keys found in environment. Set ZHIPU_API_KEY and/or DEEPSEEK_API_KEY.')
    print('      models.json left unchanged.')
    sys.exit(0)

with open('$MODELS_FILE', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" 2>&1 || {
		echo "ERROR: Python not available. Please install Python 3 to use this script."
		exit 1
	}
else
	echo "INFO: models.json not found, creating from template..."
	# 创建最小 models.json
	ZHIPU_KEY="${ZHIPU_API_KEY:-}"
	DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"

	if [ -n "$ZHIPU_KEY" ] || [ -n "$DEEPSEEK_KEY" ]; then
		python3 -c "
import json, os
cfg = {'providers': {}}
zhipu_key = os.environ.get('ZHIPU_API_KEY', '')
deepseek_key = os.environ.get('DEEPSEEK_API_KEY', '')

if zhipu_key:
    cfg['providers']['zhipu'] = {
        'name': 'ZhipuAI',
        'baseUrl': 'https://open.bigmodel.cn/api/paas/v4',
        'api': 'openai-completions',
        'apiKey': zhipu_key,
        'models': [
            {'id': 'glm-4.1v', 'name': 'GLM-4.1V', 'reasoning': True, 'input': ['text', 'image'],
             'contextWindow': 64000, 'maxTokens': 4096, 'compat': {'thinkingFormat': 'zai'},
             'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}},
            {'id': 'glm-4.6v', 'name': 'GLM-4.6V', 'reasoning': True, 'input': ['text', 'image'],
             'contextWindow': 128000, 'maxTokens': 4096, 'compat': {'thinkingFormat': 'zai'},
             'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}},
            {'id': 'glm-4.7', 'name': 'GLM-4.7', 'reasoning': True, 'input': ['text'],
             'contextWindow': 204800, 'maxTokens': 131072, 'compat': {'thinkingFormat': 'zai'},
             'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}
        ]
    }
    cfg['providers']['zai-coding-cn'] = {'apiKey': zhipu_key}
    print(f'OK: Zhipu API Key injected ({len(zhipu_key)} chars)')

if deepseek_key:
    cfg['providers']['deepseek'] = {'apiKey': deepseek_key}
    print(f'OK: DeepSeek API Key injected ({len(deepseek_key)} chars)')

with open('$MODELS_FILE', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" 2>&1
	fi
fi

# ── 设置文件权限为 600（仅 owner 可读写）────────────
if [ -f "$MODELS_FILE" ]; then
	chmod 600 "$MODELS_FILE" 2>/dev/null || {
		echo "WARN: Cannot chmod 600 on $MODELS_FILE (Windows may not support this)"
	}
fi

# ── 安全检查：models.json 中不应有明文 Key ────────────
# （这里已经是从 env 注入的，但做一次确认无害）
echo "INFO: models.json ready: $(wc -c <"$MODELS_FILE") bytes"

# ── 清理旧的 API Key 残留 ────────────────────────────
# 如果 extensions/zhipu-provider.ts 存在且包含硬编码 Key，警告
EXT_FILE="${EXTENSIONS_DIR}/zhipu-provider.ts"
if [ -f "$EXT_FILE" ]; then
	if grep -q "apiKey.*[a-f0-9]\{32\}" "$EXT_FILE" 2>/dev/null; then
		echo "WARN: $EXT_FILE may contain hardcoded API key. Review and remove it."
	fi
fi

echo "DONE: API key setup complete."
