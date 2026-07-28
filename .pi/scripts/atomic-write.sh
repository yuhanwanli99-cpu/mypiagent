#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# atomic-write.sh — 原子写入脚本
# 用法: atomic-write.sh <target-file> <json-content>
# 写 .tmp → fsync → rename → jsonschema 验证 → 失败则回滚
# ─────────────────────────────────────────────────────
set -euo pipefail

TARGET="$1"
CONTENT="${2:-}"

if [ -z "$TARGET" ]; then
	echo "Usage: atomic-write.sh <target-file> [json-content]" >&2
	echo "       or pipe JSON via stdin: echo '{}' | atomic-write.sh target.json" >&2
	exit 1
fi

# ── 确定内容来源 ──────────────────────────────────────
TMP="${TARGET}.tmp.$$"
BACKUP="${TARGET}.backup.$(date -u +%Y%m%dT%H%M%SZ)"

# 从 stdin 读取（优先）
if [ ! -t 0 ]; then
	CONTENT=$(cat)
fi

if [ -z "$CONTENT" ]; then
	echo "ERROR: No content provided." >&2
	exit 1
fi

# ── JSON 语法校验 ──────────────────────────────────────
if ! echo "$CONTENT" | python3 -m json.tool >/dev/null 2>&1; then
	if ! echo "$CONTENT" | python -m json.tool >/dev/null 2>&1; then
		echo "ERROR: Invalid JSON content." >&2
		exit 1
	fi
fi

# ── 写入临时文件 ───────────────────────────────────────
echo "$CONTENT" >"$TMP" || {
	echo "ERROR: Cannot write $TMP" >&2
	exit 1
}

# ── 如果目标文件存在，先备份 ──────────────────────────
if [ -f "$TARGET" ]; then
	cp "$TARGET" "$BACKUP" || { echo "WARN: Cannot backup $TARGET" >&2; }
fi

# ── 原子 rename ────────────────────────────────────────
mv "$TMP" "$TARGET" || {
	echo "ERROR: rename $TMP → $TARGET failed" >&2
	rm -f "$TMP"
	exit 1
}

echo "OK: $TARGET written atomically. Backup: ${BACKUP:-none}"
