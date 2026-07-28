"""SPOQ analysis v3 — Last 4 days only (Jul 25-28), post architecture change."""

import json
import os
from collections import Counter

SESSIONS_DIR = r"/mnt/c/Users/33784/.pi/agent/sessions/--F--piagent--"
RECENT = {"2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28"}


def analyze():
    sessions = sorted(
        [
            f
            for f in os.listdir(SESSIONS_DIR)
            if f.endswith(".jsonl") and f[:10] in RECENT
        ]
    )

    if not sessions:
        print("No sessions found for Jul 25-28")
        return

    main_tools = Counter()
    user_msgs, assist_msgs, tool_results = 0, 0, 0
    subagent_data = {}
    soft_rule_reads = Counter()

    for fname in sessions:
        fpath = os.path.join(SESSIONS_DIR, fname)
        date = fname[:10]
        with open(fpath, encoding="utf-8") as f:
            lines = f.readlines()

        entries = []
        for line in lines:
            try:
                entries.append(json.loads(line.strip()))
            except json.JSONDecodeError:
                pass

        for e in entries:
            t = e.get("type", "")
            if t == "message":
                msg = e.get("message", {})
                role = msg.get("role", "")
                content = msg.get("content", [])

                if role == "user":
                    user_msgs += 1
                elif role == "assistant":
                    assist_msgs += 1
                    for c in content:
                        if c.get("type") == "toolCall":
                            tn = c.get("name", "?")
                            main_tools[tn] += 1
                            if tn == "read":
                                path = c.get("arguments", {}).get("path", "")
                                if any(
                                    kw in path
                                    for kw in [
                                        ".pi/",
                                        "AGENTS.md",
                                        "lessons-learned",
                                        "agent-loops",
                                        "spoq",
                                        "plan-",
                                        "mailbox",
                                    ]
                                ):
                                    soft_rule_reads[path] += 1
                elif role == "toolResult":
                    tool_results += 1

            elif t == "custom":
                if e.get("customType") == "subagents:record":
                    d = e.get("data", {})
                    sid = d.get("id", "")
                    if sid:
                        subagent_data.setdefault(sid, {}).update(
                            {
                                "type": d.get("type", "?"),
                                "desc": d.get("description", "?"),
                                "status": d.get("status", "?"),
                                "result": d.get("result", ""),
                            }
                        )

            elif t == "custom_message":
                if e.get("customType") == "subagent-notification":
                    d = e.get("details", {})
                    sid = d.get("id", "")
                    if sid:
                        subagent_data.setdefault(sid, {}).update(
                            {
                                "toolUses": d.get("toolUses", 0),
                                "totalTokens": d.get("totalTokens", 0),
                                "durationMs": d.get("durationMs", 0),
                                "turnCount": d.get("turnCount", 0),
                            }
                        )

    subagents = list(subagent_data.values())

    # === REPORT ===
    print("=" * 60)
    print("SPOQ ANALYSIS: Last 4 Days (Jul 25-28)")
    print(f"Sessions: {len(sessions)} | Sub-agents: {len(subagents)}")
    print(
        f"User msgs: {user_msgs} | Assist msgs: {assist_msgs} | Ratio: {assist_msgs / max(user_msgs, 1):.1f}:1"
    )
    print("=" * 60)

    # 1. Sub-agents
    print("\n### SUB-AGENTS ###")
    by_type = Counter(r.get("type", "?") for r in subagents)
    by_status = Counter(r.get("status", "?") for r in subagents)
    for t, c in by_type.most_common():
        print(f"  {t}: {c}")
    for s, c in by_status.most_common():
        print(f"  status={s}: {c}")

    # Detail each
    print("\n  Detail:")
    for r in subagents:
        print(f"  [{r.get('type', '?')}] {r.get('desc', '?')[:60]}")
        print(
            f"    status={r.get('status', '?')} tools={r.get('toolUses', 0)} tokens={r.get('totalTokens', 0):,} dur={r.get('durationMs', 0) / 1000:.0f}s"
        )

    # 2. Slacking/Confusion
    print("\n### SLACKING / ROLE CONFUSION ###")
    confused = [
        r
        for r in subagents
        if r.get("type") == "tester" and "Orchestrat" in r.get("result", "")
    ]
    fails = [
        r
        for r in subagents
        if r.get("type") == "tester" and "FAIL" in r.get("result", "")[:500]
    ]
    errors = [r for r in subagents if r.get("status") == "error"]
    low_tools = [r for r in subagents if 0 < r.get("toolUses", 999) < 8]

    print(f"  Tester role-confused: {len(confused)}")
    print(f"  Tester FAIL: {len(fails)}")
    print(f"  Status=error: {len(errors)}")
    print(f"  Low tool usage (<8): {len(low_tools)}")

    if confused:
        for r in confused:
            print(f"    → {r.get('desc', '?')}: {r.get('result', '')[:200]}")

    # 3. Soft rules (last 4 days only)
    print("\n### SOFT RULES (config read as context) ###")
    cats = {
        "agent-loops/*.md": [],
        "spoq-state.json": [],
        "spoq-state.schema.md": [],
        "spoq-enforcer.ts": [],
        "AGENTS.md": [],
        "mailbox": [],
        "plan-*": [],
        "lessons-learned.md": [],
        "other .pi": [],
    }
    for path, cnt in soft_rule_reads.items():
        fn = os.path.basename(path)
        matched = False
        for cat in cats:
            if cat.rstrip("*") in fn or cat.rstrip("*") in path:
                if cat != "other .pi":
                    cats[cat].append((path, cnt))
                    matched = True
                    break
        if not matched:
            cats["other .pi"].append((path, cnt))

    total_rule = 0
    for cat, items in cats.items():
        cat_total = sum(c for _, c in items)
        total_rule += cat_total
        if cat_total > 0:
            print(f"\n  {cat}: {cat_total} reads")
            for path, cnt in sorted(items, key=lambda x: -x[1])[:4]:
                short = path.replace("C:\\Users\\33784\\.pi\\agent\\", "~/")
                short = short.replace("F:\\piagent\\", "proj/")
                short = short.replace("/mnt/f/piagent/", "proj/")
                short = short.replace("/mnt/c/Users/33784/.pi/agent/", "~/")
                print(f"    {cnt:2d}x {short}")

    print(
        f"\n  TOTAL soft-rule reads: {total_rule}/{main_tools.get('read', 1)} = {total_rule / max(main_tools.get('read', 1), 1) * 100:.0f}%"
    )

    # 4. Main agent tool usage
    print("\n### MAIN AGENT TOOLS ###")
    for name, cnt in main_tools.most_common(15):
        print(f"  {name:25s}: {cnt:3d}")

    # 5. Summary
    total_tokens = sum(r.get("totalTokens", 0) for r in subagents)
    total_dur = sum(r.get("durationMs", 0) for r in subagents)
    print(f"\n{'=' * 60}")
    print("SUMMARY (Jul 25-28)")
    print(
        f"  Sub-agent error rate: {len(errors)}/{len(subagents)} = {len(errors) / max(len(subagents), 1) * 100:.0f}%"
    )
    print(f"  Role confusion: {len(confused)}")
    print(f"  Tester FAIL: {len(fails)}")
    print(f"  Sub-agent tokens spent: {total_tokens:,}")
    print(f"  Sub-agent total time: {total_dur / 1000:.0f}s")
    print(
        f"  Soft-rule reads: {total_rule} of {main_tools.get('read', 0)} = {total_rule / max(main_tools.get('read', 0), 1) * 100:.0f}%"
    )
    print("=" * 60)


if __name__ == "__main__":
    analyze()
