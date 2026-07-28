#!/usr/bin/env python3
"""
merge-hermes-recovery.py
合并 pi-hermes-memory 的 recovery 文件到健康的 .failures.md / .MEMORY.md
去重策略：按内容前 80 字符 + 类别标签做 key，保留最新的 last 日期
"""

import os
import re
from collections import OrderedDict
from datetime import datetime

# Resolve home directory: try Windows USERPROFILE under WSL mount, then Unix HOME
_WIN_HOME = "/mnt/c/Users/33784"
_HOME = (
    _WIN_HOME
    if os.path.exists(_WIN_HOME)
    else (
        os.environ.get("USERPROFILE")
        or os.environ.get("HOME")
        or os.path.expanduser("~")
    )
)
HERMES_DIR = os.path.join(_HOME, ".pi", "agent", "pi-hermes-memory")


def parse_recovery_files(prefix):
    """Parse all recovery files matching `prefix*` and return deduplicated entries."""
    entries = OrderedDict()  # key -> (entry_text, latest_date)

    files = sorted([f for f in os.listdir(HERMES_DIR) if f.startswith(prefix)])

    print(f"  Found {len(files)} recovery files for {prefix}")

    for fname in files:
        fpath = os.path.join(HERMES_DIR, fname)
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                content = f.read()
        except Exception as e:
            print(f"  WARN: Cannot read {fname}: {e}")
            continue

        # Split by § separator
        raw_entries = [e.strip() for e in content.split("§") if e.strip()]

        for entry in raw_entries:
            # Extract category tag [correction] [failure] etc.
            tag_match = re.match(r"^\[(\w[\w-]*)\]", entry)
            tag = tag_match.group(1) if tag_match else "unknown"

            # Extract date from <!-- created=... -->
            date_match = re.search(r"created=(\d{4}-\d{2}-\d{2})", entry)
            date_str = date_match.group(1) if date_match else "0000-00-00"

            # Create dedup key: first 120 chars (strip leading tag for better matching)
            body = re.sub(r"^\[.*?\]\s*", "", entry)
            key_text = body[:120].strip()
            if not key_text:
                key_text = entry[:120].strip()
            key = f"{tag}::{key_text}"

            if key in entries:
                existing_entry, existing_date = entries[key]
                if date_str > existing_date:
                    entries[key] = (entry, date_str)
            else:
                entries[key] = (entry, date_str)

    return entries


def sort_entries(entries):
    """Sort: by category priority, then by date descending within category."""
    category_order = {
        "correction": 0,
        "failure": 1,
        "insight": 2,
        "tool-quirk": 3,
    }

    def sort_key(item):
        key, (entry, date_str) = item
        tag = key.split("::")[0]
        cat_priority = category_order.get(tag, 99)
        return (cat_priority, date_str, key)

    return OrderedDict(sorted(entries.items(), key=sort_key))


def main():
    print("=" * 60)
    print(" Pi Hermes-Memory Recovery Merger")
    print("=" * 60)

    for prefix, target_file in [
        (".failures.md.recovery-", ".failures.md"),
        (".MEMORY.md.recovery-", ".MEMORY.md"),
        (".USER.md.recovery-", ".USER.md"),
    ]:
        print(f"\n── Processing {prefix} → {target_file} ──")

        entries = parse_recovery_files(prefix)
        if not entries:
            print(f"  No entries found for {prefix}, skipping.")
            continue

        entries = sort_entries(entries)

        # Build output
        lines = []
        for key, (entry, date_str) in entries.items():
            lines.append(entry)
            lines.append("§")

        output = "\n".join(lines)
        if not output.endswith("§\n"):
            output += "§\n"

        target_path = os.path.join(HERMES_DIR, target_file)

        # Atomic write: tmp → rename
        tmp_path = target_path + f".tmp.{os.getpid()}"
        backup_path = (
            target_path + f".backup.{datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')}"
        )

        # Backup existing
        if os.path.exists(target_path):
            try:
                os.rename(target_path, backup_path)
                print(f"  Backed up existing → {os.path.basename(backup_path)}")
            except Exception as e:
                print(f"  WARN: Cannot backup: {e}")

        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(output)

        os.rename(tmp_path, target_path)

        print(f"  ✅ Written {len(entries)} unique entries → {target_file}")
        print(f"     ({len(lines) // 2} entries, {len(output)} bytes)")

        # Count categories
        cats = {}
        for key in entries:
            tag = key.split("::")[0]
            cats[tag] = cats.get(tag, 0) + 1
        for cat, count in sorted(cats.items()):
            print(f"     [{cat}]: {count}")

    # ── Cleanup: count recovery files remaining ──
    print("\n── Cleanup Report ──")
    for prefix in [
        ".failures.md.recovery-",
        ".MEMORY.md.recovery-",
        ".USER.md.recovery-",
    ]:
        count = len([f for f in os.listdir(HERMES_DIR) if f.startswith(prefix)])
        print(f"  {prefix}* : {count} files remaining")

    print("\n  To delete recovery files after verification:")
    print(
        '  del /q "%USERPROFILE%\\.pi\\agent\\pi-hermes-memory\\.failures.md.recovery-*"'
    )
    print(
        '  del /q "%USERPROFILE%\\.pi\\agent\\pi-hermes-memory\\.MEMORY.md.recovery-*"'
    )
    print('  del /q "%USERPROFILE%\\.pi\\agent\\pi-hermes-memory\\.USER.md.recovery-*"')

    print("\n" + "=" * 60)
    print(" DONE. Verify .failures.md and .MEMORY.md, then delete recovery files.")
    print("=" * 60)


if __name__ == "__main__":
    main()
