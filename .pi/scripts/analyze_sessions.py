"""Deep SPOQ pipeline analysis v2 — fixed arg paths + subagent data merge."""

import json
import os
from collections import Counter

SESSIONS_DIR = r"/mnt/c/Users/33784/.pi/agent/sessions/--F--piagent--"


def analyze():
    sessions = sorted([f for f in os.listdir(SESSIONS_DIR) if f.endswith(".jsonl")])

    main_tools = Counter()
    user_msgs, assist_msgs, tool_results = 0, 0, 0

    # Merge subagent record + notification by id
    subagent_data = {}  # id -> merged dict

    # Soft rules tracking
    soft_rule_reads = Counter()  # what files are being read
    all_reads = []

    per_session = []

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

        sess = {
            "file": fname,
            "date": date,
            "lines": len(lines),
            "size_kb": os.path.getsize(fpath) / 1024,
            "user": 0,
            "assist": 0,
            "tool_calls": 0,
            "tool_results": 0,
            "tools": Counter(),
            "sub_count": 0,
        }

        pending_notifications = {}

        for e in entries:
            t = e.get("type", "")

            if t == "message":
                msg = e.get("message", {})
                role = msg.get("role", "")
                content = msg.get("content", [])

                if role == "user":
                    sess["user"] += 1
                    user_msgs += 1
                elif role == "assistant":
                    sess["assist"] += 1
                    assist_msgs += 1
                    for c in content:
                        if c.get("type") == "toolCall":
                            tn = c.get("name", "?")
                            sess["tools"][tn] += 1
                            sess["tool_calls"] += 1
                            main_tools[tn] += 1

                            if tn == "read":
                                args = c.get("arguments", {})
                                path = args.get("path", "")
                                all_reads.append({"date": date, "path": path})
                                # Classify
                                if (
                                    ".pi/" in path
                                    or "AGENTS.md" in path
                                    or "lessons-learned" in path
                                    or "agent-loops" in path
                                    or "spoq" in path.lower()
                                ):
                                    soft_rule_reads[path] += 1

                elif role == "toolResult":
                    sess["tool_results"] += 1
                    tool_results += 1

            elif t == "custom":
                ct = e.get("customType", "")
                if ct == "subagents:record":
                    data = e.get("data", {})
                    sid = data.get("id", "")
                    if sid:
                        if sid not in subagent_data:
                            subagent_data[sid] = {}
                        subagent_data[sid].update(
                            {
                                "id": sid,
                                "type": data.get("type", "?"),
                                "description": data.get("description", "?"),
                                "status": data.get("status", "?"),
                                "result": data.get("result", ""),
                                "_date": date,
                            }
                        )
                    sess["sub_count"] += 1

            elif t == "custom_message":
                ct = e.get("customType", "")
                if ct == "subagent-notification":
                    details = e.get("details", {})
                    sid = details.get("id", "")
                    if sid:
                        if sid not in subagent_data:
                            subagent_data[sid] = {}
                        subagent_data[sid].update(
                            {
                                "id": sid,
                                "description": details.get("description", "?"),
                                "status": details.get("status", "?"),
                                "toolUses": details.get("toolUses", 0),
                                "turnCount": details.get("turnCount", 0),
                                "totalTokens": details.get("totalTokens", 0),
                                "durationMs": details.get("durationMs", 0),
                                "outputFile": details.get("outputFile", ""),
                                "_date_notify": date,
                            }
                        )

        per_session.append(sess)

    # Convert subagent_data to list
    subagents = list(subagent_data.values())

    # ===== REPORT =====
    print("=" * 70)
    print("SPOQ PIPELINE DEEP ANALYSIS v2")
    print(f"Sessions: {len(sessions)} | Sub-agents: {len(subagents)}")
    print("=" * 70)

    # 1. Overview
    print("\n### 1. SUB-AGENT OVERVIEW ###")
    by_type = Counter(r.get("type", "?") for r in subagents)
    by_status = Counter(r.get("status", "?") for r in subagents)
    for t, c in by_type.most_common():
        print(f"  {t:25s}: {c:2d}")
    print(f"  {'─' * 30}")
    for s, c in by_status.most_common():
        print(f"  status={s:15s}: {c:2d}")

    # 2. Resource usage by role
    print("\n### 2. RESOURCE USAGE BY ROLE ###")
    for role in [
        "software-architect",
        "developer",
        "tester",
        "general-purpose",
        "Explore",
    ]:
        rr = [r for r in subagents if r.get("type") == role]
        if not rr:
            continue
        tools_list = [r.get("toolUses", 0) for r in rr if r.get("toolUses", 0) > 0]
        tokens_list = [
            r.get("totalTokens", 0) for r in rr if r.get("totalTokens", 0) > 0
        ]
        dur_list = [r.get("durationMs", 0) for r in rr if r.get("durationMs", 0) > 0]
        if tools_list:
            print(f"\n  {role} ({len(rr)} total, {len(tools_list)} with data):")
            print(
                f"    tools: avg={sum(tools_list) / len(tools_list):.0f} min={min(tools_list)} max={max(tools_list)}"
            )
            print(
                f"    tokens: avg={sum(tokens_list) / len(tokens_list):.0f} min={min(tokens_list)} max={max(tokens_list)}"
            )
            print(
                f"    duration: avg={sum(dur_list) / len(dur_list) / 1000:.1f}s min={min(dur_list) / 1000:.1f}s max={max(dur_list) / 1000:.1f}s"
            )

    # 3. Slacking detection
    print("\n### 3. SLACKING / ROLE CONFUSION ###")
    # Role confusion: tester pretending to be orchestrator
    confused = [
        r
        for r in subagents
        if r.get("type") == "tester" and "Orchestrat" in r.get("result", "")
    ]
    print(f"\n  Testers role-confused (acting as Orchestrator): {len(confused)}")
    for r in confused:
        print(f"    [{r.get('description', '?')}] {r.get('result', '')[:150]}...")

    # Low effort (very few tool calls vs description)
    low = [
        r
        for r in subagents
        if r.get("toolUses", 999) < 5 and r.get("toolUses", 999) > 0
    ]
    print(f"\n  Sub-agents with <5 tool uses: {len(low)}")
    for r in sorted(low, key=lambda x: x.get("toolUses", 0)):
        print(
            f"    tools:{r.get('toolUses', 0):2d} tokens:{r.get('totalTokens', 0):6d} | {r.get('description', '?')}"
        )

    # Test FAILs
    fails = [
        r
        for r in subagents
        if r.get("type") == "tester" and "FAIL" in r.get("result", "")[:500]
    ]
    print(f"\n  Tester FAILs: {len(fails)}")
    for r in fails:
        result = r.get("result", "")
        fail_lines = [
            l.strip() for l in result.split("\n") if "FAIL" in l and len(l) < 300
        ]
        for fl in fail_lines[:2]:
            print(f"    [{r.get('description', '?')}] {fl}")

    # 4. Soft rules detection
    print("\n### 4. SOFT RULES (rules loaded as context) ###")
    print(f"  Total read calls: {main_tools.get('read', 0)}")
    print(f"  Unique files read: {len(soft_rule_reads)}")

    # Categorize
    categories = {
        "AGENTS.md": [],
        "agent-loops/*.md": [],
        "lessons-learned.md": [],
        "spoq-state.schema.md": [],
        "spoq-state.json": [],
        "spoq-enforcer.ts": [],
        "plan-*.md/schema.json": [],
        "*.mailbox*": [],
        "settings.json": [],
        "models.json": [],
        "Other .pi config": [],
    }
    for path, count in soft_rule_reads.items():
        fn = os.path.basename(path)
        if fn == "AGENTS.md":
            categories["AGENTS.md"].append((path, count))
        elif "agent-loops" in path:
            categories["agent-loops/*.md"].append((path, count))
        elif fn == "lessons-learned.md":
            categories["lessons-learned.md"].append((path, count))
        elif "spoq-state.schema" in fn:
            categories["spoq-state.schema.md"].append((path, count))
        elif fn == "spoq-state.json" or "spoq-state.json" in path:
            categories["spoq-state.json"].append((path, count))
        elif "spoq-enforcer" in path:
            categories["spoq-enforcer.ts"].append((path, count))
        elif "plan-" in fn and (fn.endswith(".md") or fn.endswith(".json")):
            categories["plan-*.md/schema.json"].append((path, count))
        elif "mailbox" in path:
            categories["*.mailbox*"].append((path, count))
        elif fn == "settings.json":
            categories["settings.json"].append((path, count))
        elif fn == "models.json":
            categories["models.json"].append((path, count))
        elif ".pi/" in path:
            categories["Other .pi config"].append((path, count))

    total_rule_reads = 0
    for cat, items in categories.items():
        cat_total = sum(c for _, c in items)
        total_rule_reads += cat_total
        if cat_total > 0:
            print(f"\n  {cat} ({cat_total} reads):")
            for path, count in sorted(items, key=lambda x: -x[1])[:5]:
                short = path.replace("C:\\Users\\33784\\.pi\\agent\\", "~/.pi/agent/")
                short = short.replace("F:\\piagent\\", "proj/")
                print(f"    {count:2d}x {short}")

    print(
        f"\n  TOTAL rule/config reads: {total_rule_reads}/{main_tools.get('read', 0)} = {total_rule_reads / max(main_tools.get('read', 0), 1) * 100:.0f}% of all reads"
    )

    # 5. Context accumulation
    print("\n### 5. CONTEXT ACCUMULATION (big sessions) ###")
    large = sorted(
        [s for s in per_session if s["size_kb"] > 300], key=lambda x: -x["size_kb"]
    )[:10]
    for s in large:
        reads = s["tools"].get("read", 0)
        Agent_calls = s["tools"].get("Agent", 0)
        get_result = s["tools"].get("get_subagent_result", 0)
        print(
            f"  {s['size_kb']:7.0f}KB | {s['date']} | u:{s['user']:3d} a:{s['assist']:3d} "
            f"tools:{s['tool_calls']:3d} | read:{reads:3d} Agent:{Agent_calls:2d} get_result:{get_result:2d} subs:{s['sub_count']}"
        )

    # 6. Main agent tool profile
    print("\n### 6. MAIN AGENT TOOL PROFILE ###")
    for name, count in main_tools.most_common(25):
        print(f"  {name:30s}: {count:4d}")

    # 7. Key findings summary
    print("\n" + "=" * 70)
    print("KEY FINDINGS SUMMARY")
    print("=" * 70)

    errors = [r for r in subagents if r.get("status") == "error"]
    confused_testers = len(confused)
    tester_fails = len(fails)
    total_tokens_spent = sum(r.get("totalTokens", 0) for r in subagents)
    total_dur = sum(r.get("durationMs", 0) for r in subagents) / 1000

    print(
        f"  Sub-agent error rate: {len(errors)}/{len(subagents)} = {len(errors) / max(len(subagents), 1) * 100:.0f}%"
    )
    print(f"  Tester role confusion: {confused_testers} instances")
    print(f"  Tester FAIL results: {tester_fails}")
    print(f"  Total sub-agent tokens: {total_tokens_spent:,}")
    print(f"  Total sub-agent duration: {total_dur:.0f}s")
    print(f"  Soft rule reads: {total_rule_reads} (rules loaded as context)")
    print(f"  Largest session: {max(s['size_kb'] for s in per_session):.0f}KB")


if __name__ == "__main__":
    analyze()
