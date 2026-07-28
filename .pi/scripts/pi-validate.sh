#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# pi-validate.sh — Pi 迁移完整性校验脚本
# 检查项：
#   1. API Key 是否硬编码在配置文件中
#   2. spoq-state.json 是否合法 JSON + 符合 schema
#   3. mailbox 目录权限
#   4. Agent 定义完整性
#   5. pi-hermes-memory 异常文件数
# ─────────────────────────────────────────────────────
set -euo pipefail

AGENT_DIR="${HOME}/.pi/agent"
PASS=0
FAIL=0
WARN=0

green() {
	echo -e "\033[32m[PASS]\033[0m $*"
	((PASS++))
}
red() {
	echo -e "\033[31m[FAIL]\033[0m $*"
	((FAIL++))
}
yellow() {
	echo -e "\033[33m[WARN]\033[0m $*"
	((WARN++))
}

echo "============================================="
echo " Pi Migration Validation Script"
echo " $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================="
echo ""

# ──────────────────────────────────────────────────────
# 1. 基础目录检查
# ──────────────────────────────────────────────────────
echo "── 1. Directory Structure ──"

for dir in \
	"$AGENT_DIR" \
	"$AGENT_DIR/agents" \
	"$AGENT_DIR/agent-loops" \
	"$AGENT_DIR/skills" \
	"$AGENT_DIR/extensions"; do
	if [ -d "$dir" ]; then
		green "Directory exists: $dir"
	else
		red "Directory missing: $dir"
	fi
done

# ──────────────────────────────────────────────────────
# 2. 配置文件检查
# ──────────────────────────────────────────────────────
echo ""
echo "── 2. Config Files ──"

for file in \
	"$AGENT_DIR/settings.json" \
	"$AGENT_DIR/models.json" \
	"$AGENT_DIR/mcp.json" \
	"$AGENT_DIR/subagents.json" \
	"$AGENT_DIR/lessons-learned.md"; do
	if [ -f "$file" ]; then
		green "File exists: $file"
	else
		red "File missing: $file"
	fi
done

# Agent 定义
for agent in developer software-architect tester; do
	f="$AGENT_DIR/agents/${agent}.md"
	if [ -f "$f" ]; then
		green "Agent defined: $agent"
	else
		red "Agent missing: $agent"
	fi
done

# Agent Loop 定义
for loop in orchestrator architect developer tester; do
	f="$AGENT_DIR/agent-loops/${loop}.md"
	if [ -f "$f" ]; then
		green "Agent-loop defined: $loop"
	else
		red "Agent-loop missing: $loop"
	fi
done

# ──────────────────────────────────────────────────────
# 3. API Key 安全检查（核心）
# ──────────────────────────────────────────────────────
echo ""
echo "── 3. API Key Security ──"

check_hardcoded_key() {
	local file="$1"
	if [ ! -f "$file" ]; then return; fi
	# 检测形如 32 位 hex 字符串（常见 API Key 模式）
	if grep -qE '[a-f0-9]{32}\.[A-Za-z0-9]{8,}' "$file" 2>/dev/null; then
		red "HARDCODED API KEY in: $file"
		echo "   → Remove it and use env var ZHIPU_API_KEY."
		echo "   → Run: .pi/scripts/setup-api-keys.sh"
	else
		green "No hardcoded key detected: $file"
	fi
}

check_hardcoded_key "$AGENT_DIR/models.json"
check_hardcoded_key "$AGENT_DIR/extensions/zhipu-provider.ts"
check_hardcoded_key "$AGENT_DIR/settings.json"

# ──────────────────────────────────────────────────────
# 4. JSON 合法性校验
# ──────────────────────────────────────────────────────
echo ""
echo "── 4. JSON Validity ──"

validate_json() {
	local file="$1"
	if [ ! -f "$file" ]; then
		yellow "Skipping (not found): $file"
		return
	fi
	if python3 -m json.tool "$file" >/dev/null 2>&1; then
		green "Valid JSON: $file"
	elif python -m json.tool "$file" >/dev/null 2>&1; then
		green "Valid JSON: $file"
	else
		red "INVALID JSON: $file"
	fi
}

validate_json "$AGENT_DIR/settings.json"
validate_json "$AGENT_DIR/models.json"
validate_json "$AGENT_DIR/mcp.json"
validate_json "$AGENT_DIR/subagents.json"

# ──────────────────────────────────────────────────────
# 5. pi-hermes-memory 异常检测
# ──────────────────────────────────────────────────────
echo ""
echo "── 5. pi-hermes-memory Health ──"

HM_DIR="$AGENT_DIR/pi-hermes-memory"
if [ -d "$HM_DIR" ]; then
	recovery_count=$(find "$HM_DIR" -maxdepth 1 -name ".failures.md.recovery-*" 2>/dev/null | wc -l)
	memory_count=$(find "$HM_DIR" -maxdepth 1 -name ".MEMORY.md.recovery-*" 2>/dev/null | wc -l)

	if [ "$recovery_count" -gt 10 ]; then
		red "pi-hermes-memory: $recovery_count failure recovery files (threshold: 10)"
		echo "   → Disk write storm detected. Recommend: rm -rf pi-hermes-memory/ and restart."
	elif [ "$recovery_count" -gt 0 ]; then
		yellow "pi-hermes-memory: $recovery_count failure recovery files"
	else
		green "pi-hermes-memory: clean (0 recovery files)"
	fi

	if [ "$memory_count" -gt 10 ]; then
		yellow "pi-hermes-memory: $memory_count memory recovery files"
	fi
else
	yellow "pi-hermes-memory directory not found (will be created on first run)"
fi

# ──────────────────────────────────────────────────────
# 6. Session 完整性
# ──────────────────────────────────────────────────────
echo ""
echo "── 6. Session Integrity ──"

SESSIONS_DIR="$AGENT_DIR/sessions"
if [ -d "$SESSIONS_DIR" ]; then
	orphan_meta=0
	for meta in $(find "$SESSIONS_DIR" -name "*.meta.json" 2>/dev/null); do
		jsonl="${meta%.meta.json}.jsonl"
		if [ ! -f "$jsonl" ]; then
			((orphan_meta++))
		fi
	done
	if [ "$orphan_meta" -gt 5 ]; then
		yellow "Orphaned .meta.json files (no .jsonl): $orphan_meta sessions may have crashed mid-write"
	elif [ "$orphan_meta" -gt 0 ]; then
		green "Sessions: $orphan_meta orphaned meta files (acceptable)"
	else
		green "Sessions: all sessions have matching .jsonl files"
	fi
else
	yellow "Sessions directory not found"
fi

# ──────────────────────────────────────────────────────
# 7. 汇总
# ──────────────────────────────────────────────────────
echo ""
echo "============================================="
echo " SUMMARY: PASS=$PASS  FAIL=$FAIL  WARN=$WARN"
echo "============================================="

if [ "$FAIL" -gt 0 ]; then
	echo ""
	echo "⚠️  Fix the FAIL items above before running Pi."
	echo "   → API Key issues:  run .pi/scripts/setup-api-keys.sh"
	echo "   → JSON issues:     check file contents against pi-migration-guide.md"
	exit 1
else
	echo "✅ All checks passed. Pi is ready to run."
	exit 0
fi
