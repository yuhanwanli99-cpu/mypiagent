# SPOQ State Machine Schema v2.0 (Lightweight)

## 状态文件: `.pi/spoq-state.json`

状态文件是 SPOQ 流水线的唯一真相源。Orchestrator 不记忆任何状态——每次启动从文件读取，每步操作后写回。

## v2 单一真相源（Source of Truth）

本文件是 SPOQ 规则唯一权威来源。若以下文件与本文件冲突，以本文件为准：

- `AGENTS.md`
- `.pi/agent-loops/*.md`
- `.pi/extensions/spoq-enforcer.ts`

这些文件只允许做“执行层描述”，不允许定义与本文件冲突的新状态或新转换。

---

## 顶层结构

```json
{
  "version": "1.0",
  "dag": { "tasks": { "<task-id>": "<TaskState>" } },
  "currentWave": 0,
  "totalWaves": 2,
  "lessons": ["..."],
  "phase": "executing",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601"
}
```

## v2 轻量化执行档位

- **Simple Track**（小任务）：`pending -> developing -> dev_done -> testing -> done`
- **Complex Track**（复杂任务）：`pending -> architecting -> plan_done -> developing -> dev_done -> testing -> done`

档位只由 `task.complexity` 决定，不允许临时改流程。

## TaskState

| 字段 | 类型 | 说明 |
| ------ | ------ | ------ |
| id | string | 任务唯一标识 |
| name | string | 人类可读任务名 |
| wave | number | 所属 Wave 编号 |
| complexity | string | "simple"\|\"complex\"——简单任务跳过 Architect，复杂任务走完整链路 |
| needsVisualEvidence | boolean | 是否需要视觉/UI 验证——true 时 T9 派发 tester-visual（glm-4.1v），false 时派发 tester（deepseek-v4-flash） |
| dependencies | string[] | 依赖的任务 ID 列表 |
| state | StateEnum | 当前状态（见下方状态机） |
| retryCount | number | 当前阶段的重试次数 |
| maxRetries | number | 最大重试次数（默认 3） |
| agentId | string\|null | 当前运行中的子代理 ID |
| resumeAgentId | string\|null | 上次运行的 agentId，用于 fix 循环中 resume（而非重建） |
| agentType | string\|null | 当前子代理类型 |
| error | string\|null | 最近错误信息 |
| lowQualityPass | boolean | 是否为低质量通过（retry >= 3 后标记 done 而非 blocked） |
| planPath | string\|null | plan-{task}.md 路径 |
| testPath | string\|null | test-{task}.md 路径 |
| srcPath | string\|null | src/{task}/ 路径 |
| transitionLog | TransitionEntry[] | 状态变迁历史 |

### 字段分层（v2）

**驱动状态机的必需字段（Required）**

- `id`
- `complexity`
- `needsVisualEvidence`
- `wave`
- `dependencies`
- `state`
- `retryCount`
- `maxRetries`
- `agentId`
- `agentType`
- `lowQualityPass`
- `transitionLog`

**执行追踪字段（Recommended）**

- `resumeAgentId`
- `error`
- `planPath`
- `testPath`
- `srcPath`

**可选描述字段（Optional，可省略）**

- `name`
- `description`

### 必填字段与默认值（缺失时自动补齐）

```json
{
  "id": "<task-id>",
  "complexity": "complex",
  "needsVisualEvidence": false,
  "wave": 0,
  "dependencies": [],
  "state": "pending",
  "retryCount": 0,
  "maxRetries": 3,
  "agentId": null,
  "resumeAgentId": null,
  "agentType": null,
  "error": null,
  "lowQualityPass": false,
  "planPath": null,
  "testPath": null,
  "srcPath": null,
  "transitionLog": []
}
```

## StateEnum（硬状态机）

```
                 ┌──────────────────────────────┐
                 │          blocked              │
                 │  (retry >= 3 or unrecoverable) │
                 └──────────────────────────────┘
                    ↑         ↑         ↑
                    │         │         │
  pending → architecting → plan_done → developing → dev_done → testing → done
                ↑               │           │           │    │        │
                │               │           │           │    │        ├─ low_quality_pass (retry >= 3)
                │               │           │           │    │        │
                │               └─── retry ─┘           │    │        │
                │                         └── retry ────┘    │        │
                │                                            │        │
                ├────── T11a: 设计缺陷 FAIL ─────────────────┘        │
                │                                                      │
              ◄────────────── T11: 实现缺陷 FAIL (< 3) ───────────────┘
              ◄─────── low_quality_pass (retry >= 3) ────────────────┘
```

## 执行态落盘契约（新增，P0）

当顶层 `phase="executing"` 时，以下字段为**状态相关必填**（缺失视为状态机落盘不完整）：

| task.state | 必须落盘字段 |
| --- | --- |
| architecting | `agentId`, `agentType`, `transitionLog` |
| plan_done | `planPath`, `transitionLog` |
| developing | `planPath`（complex 任务）, `agentId`, `agentType`, `transitionLog` |
| dev_done | `srcPath`, `transitionLog` |
| testing | `srcPath`, `agentId`, `agentType`, `transitionLog` |
| done（非 lowQualityPass） | `transitionLog`；若经过 testing，还必须有 `testPath` 且报告为严格 PASS；complex 任务还必须有 `planPath` |

补充规则：

1. `transitionLog` 不能只存在空数组：任务离开 `pending` 后必须至少有 1 条变迁记录。
2. 每个 Wave 结束后必须同步写入 `lessons[]`（至少 1 条），否则视为经验闭环缺失。

## 硬转换表（Orchestrator 必须严格遵循，零歧义）

| # | 当前状态 | 触发条件 | 下一状态 | 动作 |
| --- | --------- | --------- | --------- | ------ |
| 1 | pending | complexity="complex" + 依赖全部 done + 当前 wave 激活 | architecting | dispatch architect, 记录 agentId |
| 1a | pending | complexity="simple" + 依赖全部 done + 当前 wave 激活 | developing | 跳过 architect，dispatch developer (isolation="worktree"), 记录 agentId |
| 2 | architecting | plan-{task}.md 已创建 | plan_done | 验证 plan 非空, 记录 planPath |
| 3 | architecting | agent 超时/崩溃 + retryCount < maxRetries | architecting | retryCount++, 重派 architect |
| 4 | architecting | agent 超时/崩溃 + retryCount >= maxRetries | done (lowQualityPass) | 标记 lowQualityPass, 记录 error |
| 5 | plan_done | 自动（无等待） | developing | dispatch developer, 传入 plan 路径 |
| 6 | developing | agent 正常退出 + selfCheck: 文件在 src/{task}/ 内 | dev_done | 记录 srcPath |
| 7 | developing | agent 超时/崩溃 + retryCount < maxRetries | developing | retryCount++, 重派 developer |
| T6a | developing | agent 终止 + 失败 + retry < 3 + resumeAgentId 存在 | developing | retry++，resume 原 agentId 传入反馈 |
| 8 | developing | agent 超时/崩溃 + retryCount >= maxRetries | done (lowQualityPass) | 标记 lowQualityPass, 记录 error |
| 9 | dev_done | 自动（无等待） | testing | 按 `task.needsVisualEvidence` 派发：true → tester-visual（zhipu/glm-4.1v），false → tester（deepseek/deepseek-v4-flash）；传入 plan + src 路径 |
| 10 | testing | test-{task}.md 存在 + 严格 PASS（仅 PASS，且不含 FAIL/CONDITIONAL PASS/with reservations） | done | 记录 testPath, 任务完成 |
| 11 | testing | test-{task}.md FAIL（实现缺陷）+ retryCount < maxRetries | developing | retryCount++, 退回开发者（附失败详情） |
| 11a | testing | test-{task}.md FAIL（设计缺陷）+ retryCount < maxRetries | architecting | retryCount++, 退回架构师修正设计（混合协议） |
| 12 | testing | test-{task}.md 存在 + 结果 FAIL + retryCount >= maxRetries | done (lowQualityPass) | 标记 lowQualityPass, 记录 error |
| 13 | testing | agent 超时/崩溃 + retryCount < maxRetries | testing | retryCount++，优先 resume 原 agentId（保留审查上下文）；resume 失败时重派 |
| 14 | testing | agent 超时/崩溃 + retryCount >= maxRetries | done (lowQualityPass) | 标记 lowQualityPass, 记录 error |
| 15 | blocked | 用户手动解除 | (回退到之前状态) | retryCount 清零 |
| 16 | done (lowQualityPass) | 任意 | done | 自动转为 done（lowQualityPass 等效于 done 的终态） |

## 邮箱协议（v2 — 修复 #2 并发安全）

## 产物定位协议（消除路径冲突）

Orchestrator 对 plan/schema/test 文件必须按以下优先级定位：

1. `.pi/spoq-mailbox/{task-id}/plan-{task-id}.md`，否则 `docs/plan-{task-id}.md`
2. `.pi/spoq-mailbox/{task-id}/plan-{task-id}.schema.json`，否则 `docs/plan-{task-id}.schema.json`
3. `.pi/spoq-mailbox/{task-id}/test-{task-id}.md`，否则 `docs/test-{task-id}.md`

命中后把实际路径写回 task 的 `planPath/testPath`，避免判定与真实产物脱节。

子代理之间通过 `.pi/spoq-mailbox/{task-id}/` 通信。Orchestrator 在派发子代理时，必须告知邮箱路径。

### 文件命名

**所有邮件使用时间戳命名避免覆写：`{from}→{to}-{ISO8601-timestamp}.md`**

示例：

- `architect→developer-2026-07-16T14:30:00Z.md` — 架构师给开发者的说明
- `developer→architect-2026-07-16T14:35:00Z.md` — 开发者对设计的质疑
- `tester→developer-2026-07-16T14:45:00Z.md` — 测试者报告的失败详情
- `any→orchestrator-2026-07-16T14:50:00Z.md` — 任何代理给 Orchestrator 的消息

### 读取规则

1. **列出目录文件**（使用 `ls` 工具）
2. **过滤**出目标发件人的邮件：`{from}→{to}-*.md`
3. **按文件名时间戳排序**，读取最新的那条

### 多写者安全

`any→orchestrator-*.md` 可被多个代理同时写入。时间戳命名确保每次写入都是独立文件，不会发生覆写竞态条件。

## Orchestrator 主循环（伪代码）

```
loop:
  state = load(".pi/spoq-state.json")

  // 1. 轮询运行中的代理
  for task in state.dag.tasks:
    if task.agentId != null:
      result = poll(task.agentId)
      if result.done:
        apply_transition(task, result)
        task.agentId = null

  // 2. 找到当前 Wave 中需要推进的任务
  wave = state.dag.tasks 中 state != done 且 state != blocked 的最小 wave
  ready = wave 中依赖全部 done 且 state 可转换的任务

  // 3. 派发
  for task in ready:
    transition = lookup_table(task.state, trigger)
    agentId = dispatch(transition.agentType, build_prompt(task))
    task.agentId = agentId
    task.state = transition.next
    task.transitionLog.push({from, to, timestamp})

  // 4. 持久化
  save(state)

  // 5. 终止检查
  if 所有任务 done or blocked:
    report_summary()
    break
```
