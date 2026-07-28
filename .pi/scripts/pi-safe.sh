#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# pi-safe.sh — Pi 安全启动包装器
# 启动前自动检查 hermes 健康 / JSON 完整性
# 通过后才启动 Pi。失败则自动尝试修复
# 用法: pi-safe.sh [pi 的其他参数]
# ─────────────────────────────────────────────────────
set -euo pipefail

# 路径
HERMES_DIR="${HOME}/.pi/agent/pi-hermes-memory"
# 如果 HOME 解析不了，用 Windows 路径
if [ ! -d "$HERMES_DIR" ]; then
	WIN_HOME=$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r' || echo "")
	if [ -n "$WIN_HOME" ] && [ -d "${WIN_HOME}/.pi/agent/pi-hermes-memory" ]; then
		HERMES_DIR="${WIN_HOME}/.pi/agent/pi-hermes-memory"
	fi
fi

echo "🔍 Pi Safe Start — pre-flight check..."

# ── 1. Hermes 恢复文件检查 ─────────────────────────────
RECOVERY_COUNT=0
if [ -d "$HERMES_DIR" ]; then
	RECOVERY_COUNT=$(find "$HERMES_DIR" -maxdepth 1 \( -name ".failures.md.recovery-*" -o -name ".MEMORY.md.recovery-*" -o -name ".USER.md.recovery-*" \) 2>/dev/null | wc -l)
fi

if [ "$RECOVERY_COUNT" -gt 10 ]; then
	echo "⚠️  WARNING: $RECOVERY_COUNT hermes recovery files detected!"
	echo "   This indicates a concurrent write storm. Auto-merging..."

	# 尝试运行合并脚本
	SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
	MERGE_SCRIPT="${SCRIPT_DIR}/merge-hermes-recovery.py"

	if [ -f "$MERGE_SCRIPT" ]; then
		python3 "$MERGE_SCRIPT" && echo "   ✅ Merged. Restarting check..." || echo "   ❌ Merge failed."
	else
		echo "   ❌ merge-hermes-recovery.py not found at $MERGE_SCRIPT"
		echo "   Run manually: python .pi/scripts/merge-hermes-recovery.py"
	fi

	# 重新检查
	RECOVERY_COUNT=$(find "$HERMES_DIR" -maxdepth 1 \( -name ".failures.md.recovery-*" -o -name ".MEMORY.md.recovery-*" -o -name ".USER.md.recovery-*" \) 2>/dev/null | wc -l)
fi

if [ "$RECOVERY_COUNT" -gt 0 ] && [ "$RECOVERY_COUNT" -le 10 ]; then
	echo "ℹ️  $RECOVERY_COUNT recovery files (acceptable)."
elif [ "$RECOVERY_COUNT" -eq 0 ]; then
	echo "✅ Hermes memory: clean (0 recovery files)"
fi

if [ "$RECOVERY_COUNT" -gt 50 ]; then
	echo "🛑 BLOCKED: $RECOVERY_COUNT recovery files. Manual intervention required."
	echo "   Run: python .pi/scripts/merge-hermes-recovery.py"
	exit 1
fi

# ── 2. JSON 完整性快速检查 ────────────────────────────
AGENT_DIR="${HOME}/.pi/agent"
for f in "$AGENT_DIR/settings.json" "$AGENT_DIR/models.json"; do
	if [ -f "$f" ]; then
		if python3 -m json.tool "$f" >/dev/null 2>&1; then
			echo "✅ $(basename "$f"): valid JSON"
		else
			echo "❌ $(basename "$f"): INVALID JSON!"
			exit 1
		fi
	fi
done

# ── 3. 启动 Pi ─────────────────────────────────────────
echo ""
echo "🚀 All checks passed. Starting Pi..."
echo ""

exec pi "$@"
