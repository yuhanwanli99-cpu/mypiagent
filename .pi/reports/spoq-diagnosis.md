# SPOQ 多 Agent 流水线诊断报告

> 数据源：pi coding agent 会话记录（2026-07-13 至 07-28，51 session，59 次子 Agent 派发）
> 上下文：该流水线使用 Phase 0/1/2 三阶段编排，Architect→Developer→Tester 角色链路，硬转换表驱动

---

## 1. 架构概览

```
Orchestrator (主 Agent, deepseek-v4-pro)
  ├── Phase 0: 自由探索
  ├── Phase 1: 结构化规划 → 拆 DAG → 排 Wave → 用户确认
  └── Phase 2: 状态机执行
       ├── Architect (deepseek-v4-flash) → 产出 plan-{id}.md + schema.json
       ├── Developer (deepseek-v4-flash) → 产出 src/{id}/
       └── Tester    (glm-4.6v)         → 产出 test-{id}.md (PASS/FAIL)
```

规则存储方式：AGENTS.md（SPOQ 编排规则）+ agent-loops/*.md（角色定义）+ spoq-state.schema.md（状态机）+ spoq-state.json（运行时状态），全部通过 Orchestrator 每次 `read` 加载到上下文。

---

## 2. 发现的三大问题

### 问题 A：子 Agent 偷懒（Tester 尤其严重）

**数据**：

| 角色 | 派发次数 | 平均工具调用 | 平均 Token | 平均耗时 |
| ------ | --------- | ------------- | ----------- | --------- |
| Architect | 8 | 30 | 45,903 | 115s |
| Developer | 15 | 43 | 263,331 | 322s |
| **Tester** | **17** | **11** | **136,150** | **271s** |

- Tester 平均只用 11 次工具调用，但耗时 271s——大部分时间用于"读文件+写报告文字"，而非实际运行测试验证
- **2 次角色错乱**：Tester 直接把自己当 Orchestrator，拆任务派代理（输出含"我将作为 Orchestrator 调度师来处理这个任务"）
- **3 次 FAIL**：Tester 测出问题但走 low_quality_pass 放行
- 子 Agent 总错误率：**20%（12/59）**

**根因**：角色定义是"软规则"——Tester 的 agent-loop 里有"你不是 Orchestrator，不要拆任务派代理"，但这只是一段文本，模型可以忽略。

### 问题 B：主 Agent 上下文爆炸

**数据**：

- 最大单 session：**2.8MB**，252 条 assistant 消息
- 辅助/用户消息比：**4.8 : 1**
- 总 read 调用：893 次

单个 session 膨胀路径：

```
2026-07-13:  2816KB, u:39,  a:252  ← Orchestrator 承载了所有上下文
2026-07-15:  2333KB, u:55,  a:244
2026-07-16:  1511KB, u:49,  a:243, 25 sub-agents dispatched
```

**根因**：Orchestrator 的 context 里塞满了本应由扩展/子 Agent 承载的信息。所有 agent-loops 定义、转换表规则、schema 定义都在 Orchestrator 的上下文里"软传递"。

### 问题 C：规则软传递（最核心）

**数据**：**20% 的 read 调用（154/782）是在加载本应硬编码的规则**

被反复读取的文件：

| 文件 | 读取次数 | 应当的归属 |
| ------ | --------- | ----------- |
| agent-loops/*.md（Architect/Dev/Tester角色定义） | **56次** | 子 Agent 的 system prompt |
| spoq-state.json | 20次 | 扩展内存管理，通过 write 拦截维护 |
| spoq-state.schema.md（转换表+状态落盘契约） | 10次 | spoq-enforcer 扩展逻辑 |
| spoq-enforcer.ts | 10次 | 扩展自身，不应被 read |
| AGENTS.md | 3次 | 应分解到扩展 + prompt 模板 |

**按天趋势（架构变更后反而恶化）**：

```
7/13:  6次  ← 旧架构
7/16: 32次  ← SPOQ 重构当天，规则读取暴增
7/17: 56次  ← 峰值
7/20:  5次
```

---

## 3. 业界解决方案调研

### 3.1 上下文膨胀治理

**Anthropic 上下文工程**（Effective Context Engineering）：

- `/context` 命令显示 context 分布（system prompt、tools、messages、memory）
- `disableBundledSkills` / `disableWorkflows` 关闭不用的特性
- `permissions.deny` 去掉不用的工具定义（裸名去工具，scoped 只拦截调用）
- 代理中间件抓取实际请求 payload，看哪些工具/指令占用最大
- **关键原则**："每轮都发送但你用不到的东西，就是浪费"

**Claude Code 子 Agent 设计**：

- 子 Agent 运行在独立 context window，不污染主会话
- 内置 Explore（只读搜索）、Plan（规划研究）、general-purpose
- 可自定义 system prompt + tool access + model
- **核心洞察**："Use one when a side task would flood your main conversation"

### 3.2 角色强制执行

**Delegated Reasoning 模式**（40+ 生产工作流验证）：

- **铁律：Orchestrator 必须从不执行代码**——只拆解、委派、验证、升级
- 30 秒规则：如果 Orchestrator 能在 30 秒内完成 → 自己做；否则 → 必须 spawn Agent
- **Artifact-based 通信**：子 Agent 产出结构化 JSON artifact 到磁盘，Orchestrator 读 artifacts 不读原始输出
- 产出验证：每次 dispatch 后检查 artifact 是否存在 + 是否包含必需字段 → 不满足则写 blocker
- **不同模型做不同角色**：Orchestrator→Sonnet（可靠指令跟随），SWE→Codex（代码执行），Review→Gemini（大上下文审查）

**Suhail Orchestrator 教训**：

- 子 Agent 缺工具时不会报错，而是"即兴发挥"——模型会用最接近的方式模拟缺失的工具
- 修复：验证每次 dispatch 确实产出了 artifact，不只信叙述

### 3.3 懒散检测

**AIWG Laziness Detector**（aiwg 框架）：

- 检测模式：Agent 输出包含"Let me know if you need anything else" → 标记为懒散
- 检测模式：Agent 反复读相同文件不产出 → 标记为循环
- 检测模式：Agent 产出远少于预期 → 触发重试或升级

### 3.4 Pi 扩展可用的 Hook 点

Pi 扩展 API 提供了可直接使用的生命周期事件（TS 文件放入 `~/.pi/agent/extensions/`）：

- `before_agent_start` — **可注入/修改 system prompt**，在 Agent 启动前拦截
- `agent_settled` — Agent 完全空闲后触发（用于自动续跑/检查）
- `tool_call` — **可拦截任意工具调用**（如拦截 Agent() 派发，注入子 Agent prompt）
- `agent_end` — Agent 运行结束时触发（可检查产出）
- `message_end` — 消息结束时触发（可检测角色错乱关键词）
- `registerTool` — 注册自定义工具
- `registerCommand` — 注册 / 命令

---

## 4. 可硬化改造方案（按优先级）

### P0-1: 子 Agent prompt 模板化

**改什么**：Architect/Developer/Tester 的完整角色定义从 agent-loops/*.md 搬到扩展中
**怎么改**：spoq-enforcer.ts 监听 `tool_call` 事件 → 当工具名为 `Agent` 时 → 根据 agentType 注入对应的 system prompt 覆盖
**消除**：56 次 agent-loops read
**Pi Hook**：`pi.on("tool_call", ...)` + `event.input` 修改

### P0-2: 转换表硬编码

**改什么**：T1-T16 转换表 + 状态落盘契约从 AGENTS.md/spoq-state.schema.md 搬到 spoq-enforcer.ts
**怎么改**：扩展内部维护硬编码的转换表 → 在 Orchestrator 写 spoq-state.json 时校验 → 在 Agent dispatch 时自动应用正确的转换
**消除**：10+20+3 = 33 次规则 read
**Pi Hook**：`pi.on("tool_call", ...)` 拦截 `write`/`Agent` 调用

### P1-1: 子 Agent 角色错乱检测

**改什么**：检测 Tester 输出包含 Orchestrator 行为 → 自动标记 + 重试
**怎么改**：扩展监听 `agent_end`，检查子 Agent 输出中是否含"Orchestrator"/"拆任务"/"派代理"等关键词
**Pi Hook**：`pi.on("agent_end", ...)` 或 `pi.on("message_end", ...)`

### P1-2: 自动教训注入

**改什么**：Agent dispatch 时自动从 lessons-learned.md 取最新 2-3 条注入
**怎么改**：扩展在 `before_agent_start` 时读取 lessons-learned.md → 追加到 system prompt
**Pi Hook**：`pi.on("before_agent_start", ...)`

### P2: 上下文监控

**改什么**：扩展监控 session 大小 → 超 1MB 自动建议 /compact
**怎么改**：扩展在 `agent_settled` 时调用 `ctx.getContextUsage()`
**Pi Hook**：`pi.on("agent_settled", ...)` + `ctx.getContextUsage()`

---

## 5. 改造后的架构目标

```
spoq-enforcer.ts（扩展，硬编码）:
  ├── 硬转换表（T1-T16 逻辑）
  ├── 子 Agent prompt 模板（Architect/Dev/Tester system prompt）
  ├── 角色错乱检测正则
  ├── 落盘校验（transitionLog/lessons 非空检查）
  └── 上下文监控 + 自动 compact 建议

AGENTS.md（大幅缩减）:
  └── 仅保留高层概述 + 指向 spoq-enforcer 的说明

agent-loops/*.md:
  └── 删除或改为 spoq-enforcer 的配置引用

spoq-state.schema.md:
  └── 保留作为文档参考，不再被 Orchestrator read
```

---

## 6. 关键数据一图总结

```
59 次子 Agent 派发
├── 12 次 error (20%)
├── 2 次 Tester 角色错乱
├── 3 次 Tester FAIL
│
├── Architect: avg 30 tools, 115s
├── Developer: avg 43 tools, 322s  
└── Tester:    avg 11 tools, 271s  ← 偷懒热点

154/782 次 read = 20% 软规则读取
├── agent-loops:  56x ← 最大浪费
├── spoq-state:   20x
├── schema:       10x
├── enforcer:     10x
└── AGENTS.md:     3x

最大 session: 2.8MB, 252 assist msgs, ratio 6.5:1
```
