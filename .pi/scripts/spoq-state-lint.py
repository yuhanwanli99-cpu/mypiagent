#!/usr/bin/env python3
"""Lint/normalize SPOQ state file for deterministic state-machine execution."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple


VALID_PHASES = {"planning", "executing", "done"}
VALID_STATES = {
    "pending",
    "architecting",
    "plan_done",
    "developing",
    "dev_done",
    "testing",
    "done",
    "blocked",
}

REQUIRED_TASK_KEYS = {
    "id",
    "complexity",
    "wave",
    "dependencies",
    "state",
    "retryCount",
    "maxRetries",
    "agentId",
    "agentType",
    "lowQualityPass",
    "transitionLog",
}

RECOMMENDED_TASK_KEYS = {
    "resumeAgentId",
    "error",
    "planPath",
    "testPath",
    "srcPath",
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def task_defaults(task_id: str) -> Dict[str, Any]:
    return {
        "id": task_id,
        "complexity": "complex",
        "wave": 0,
        "dependencies": [],
        "state": "pending",
        "retryCount": 0,
        "maxRetries": 3,
        "agentId": None,
        "resumeAgentId": None,
        "agentType": None,
        "error": None,
        "lowQualityPass": False,
        "planPath": None,
        "testPath": None,
        "srcPath": None,
        "transitionLog": [],
    }


def _is_str_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def normalize_task(task_id: str, task: Dict[str, Any]) -> Dict[str, Any]:
    normalized = task_defaults(task_id)
    normalized.update(task)
    normalized["id"] = task_id

    if normalized["complexity"] not in ("simple", "complex"):
        normalized["complexity"] = "complex"
    if normalized["state"] not in VALID_STATES:
        normalized["state"] = "pending"
    if not isinstance(normalized["wave"], int) or normalized["wave"] < 0:
        normalized["wave"] = 0
    if not _is_str_list(normalized["dependencies"]):
        normalized["dependencies"] = []
    if not isinstance(normalized["retryCount"], int) or normalized["retryCount"] < 0:
        normalized["retryCount"] = 0
    if not isinstance(normalized["maxRetries"], int) or normalized["maxRetries"] < 1:
        normalized["maxRetries"] = 3
    if not isinstance(normalized["lowQualityPass"], bool):
        normalized["lowQualityPass"] = False
    if not isinstance(normalized["transitionLog"], list):
        normalized["transitionLog"] = []
    return normalized


def normalize_state(raw: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    warnings: List[str] = []
    state = copy.deepcopy(raw)
    state.setdefault("version", "1.0")
    state.setdefault("phase", "planning")
    state.setdefault("dag", {"tasks": {}})
    state.setdefault("currentWave", 0)
    state.setdefault("totalWaves", 0)
    state.setdefault("lessons", [])
    state.setdefault("createdAt", utc_now())
    state.setdefault("updatedAt", state["createdAt"])

    if state["phase"] not in VALID_PHASES:
        warnings.append(f"Invalid phase '{state['phase']}' -> 'planning'")
        state["phase"] = "planning"

    dag = state.get("dag")
    if not isinstance(dag, dict):
        warnings.append("Invalid dag -> reset")
        dag = {"tasks": {}}
        state["dag"] = dag

    tasks = dag.get("tasks")
    if not isinstance(tasks, dict):
        warnings.append("Invalid dag.tasks -> reset")
        tasks = {}
        dag["tasks"] = tasks

    normalized_tasks: Dict[str, Dict[str, Any]] = {}
    for task_id, task in tasks.items():
        if not isinstance(task, dict):
            warnings.append(f"Task '{task_id}' is not an object -> reset defaults")
            task = {}
        normalized_tasks[task_id] = normalize_task(task_id, task)

    dag["tasks"] = normalized_tasks

    if normalized_tasks:
        waves = [t["wave"] for t in normalized_tasks.values()]
        max_wave = max(waves)
        state["totalWaves"] = max_wave + 1
        unfinished = [t["wave"] for t in normalized_tasks.values() if t["state"] not in ("done", "blocked")]
        state["currentWave"] = min(unfinished) if unfinished else state["totalWaves"]
    else:
        state["totalWaves"] = 0
        state["currentWave"] = 0

    if not _is_str_list(state.get("lessons", [])):
        warnings.append("Top-level lessons is not string[] -> reset []")
        state["lessons"] = []

    return state, warnings


def validate_dependencies(state: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    tasks = state["dag"]["tasks"]
    task_ids = set(tasks.keys())
    for task_id, task in tasks.items():
        for dep in task["dependencies"]:
            if dep not in task_ids:
                errors.append(f"{task_id}: missing dependency '{dep}'")
    return errors


def compact_state(state: Dict[str, Any]) -> Dict[str, Any]:
    compacted = copy.deepcopy(state)
    tasks = compacted.get("dag", {}).get("tasks", {})
    for task_id, task in list(tasks.items()):
        kept: Dict[str, Any] = {}
        for key in list(REQUIRED_TASK_KEYS | RECOMMENDED_TASK_KEYS):
            if key in task:
                kept[key] = task[key]
        kept["id"] = task_id
        tasks[task_id] = kept
    return compacted


def main() -> int:
    parser = argparse.ArgumentParser(description="Lint/normalize .pi/spoq-state.json")
    parser.add_argument("--state", default=".pi/spoq-state.json", help="Path to spoq-state.json")
    parser.add_argument("--write", action="store_true", help="Write normalized output back to file")
    parser.add_argument("--strict", action="store_true", help="Fail on warnings")
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Drop optional descriptive task fields to keep state minimal",
    )
    args = parser.parse_args()

    path = Path(args.state)
    if not path.exists():
        print(f"[ERROR] state file not found: {path}", file=sys.stderr)
        return 2

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"[ERROR] invalid JSON: {exc}", file=sys.stderr)
        return 2

    state, warnings = normalize_state(raw)
    dep_errors = validate_dependencies(state)

    for msg in warnings:
        print(f"[WARN] {msg}")
    for msg in dep_errors:
        print(f"[ERROR] {msg}")

    if args.compact:
        state = compact_state(state)

    changed = state != raw
    if changed:
        print("[INFO] normalization changed state content")

    if args.write and changed:
        state["updatedAt"] = utc_now()
        path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[OK] wrote normalized state: {path}")

    if dep_errors:
        return 1
    if args.strict and warnings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
