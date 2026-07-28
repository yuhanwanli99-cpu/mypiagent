# Pi 架构迁移指南

> 本文档包含完整的 Pi 编码代理架构。在一台新电脑上，只需要：
>
> 1. 安装 Node.js + Git Bash
> 2. 安装 Pi
> 3. 把本文档交给一个 AI 代理，让它按以下步骤创建所有配置文件

---

## 一、前置环境

### 1.1 Windows 必需

```bash
# 安装 Git for Windows（提供 Git Bash，Pi 在 Windows 上依赖它）
# 下载: https://git-scm.com/download/win
```

### 1.2 安装 Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### 1.3 设置 API Key

```bash
# 智谱 AI Key（请在智谱开放平台获取你自己的 Key）
# https://open.bigmodel.cn/
# 用环境变量方式设置：
setx ZHIPU_API_KEY "your-api-key-here"
```

---

## 二、全局配置层 (`~/.pi/agent/`)

> AI 代理：请在 `%USERPROFILE%\.pi\agent\` 下创建以下文件。
> 每个代码块 = 一个文件，路径标注在 `###` 标题上。

---

### 2.1 `%USERPROFILE%\.pi\agent\settings.json`

```json
{
  "lastChangelogVersion": "0.80.8",
  "theme": "dark",
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-pro",
  "packages": [
    "npm:pi-web-access",
    "npm:@tintinweb/pi-subagents",
    "npm:pi-goal",
    "npm:pi-committer",
    "npm:pi-lens",
    "npm:pi-hermes-memory",
    "npm:pi-ask-user",
    "npm:pi-tool-display"
  ],
  "extensions": [],
  "defaultThinkingLevel": "max"
}
```

> **注意**：`extensions` 数组留空。zhipu-provider 改为通过 models.json 中的 `zai-coding-cn` 配置对接，不再需要扩展文件。

---

### 2.2 `%USERPROFILE%\.pi\agent\models.json`

> **⛔ 安全规则：永远不要在 models.json 中手写 API Key。**
> 使用下面的自动化脚本从环境变量注入。

**步骤：**

```bash
# 1. 先设置环境变量
setx ZHIPU_API_KEY "你的智谱API密钥"
# 如果也用 DeepSeek：
setx DEEPSEEK_API_KEY "你的DeepSeek密钥"

# 2. 运行安全注入脚本（从 .pi/scripts/ 目录）
bash .pi/scripts/setup-api-keys.sh
```

脚本会自动创建 models.json（`apiKey` 从环境变量注入，文件权限 600）。

**模板（仅供脚本参考，不要手写 Key）：**

```json
{
  "providers": {
    "zhipu": {
      "name": "ZhipuAI",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "api": "openai-completions",
      "apiKey": "<INJECTED BY SCRIPT>",
      "models": [
        {
          "id": "glm-4.6v",
          "name": "GLM-4.6V",
          "api": "openai-completions",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 4096,
          "compat": { "thinkingFormat": "zai" },
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "glm-4.7",
          "name": "GLM-4.7",
          "api": "openai-completions",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 204800,
          "maxTokens": 131072,
          "compat": { "thinkingFormat": "zai" },
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    },
    "zai-coding-cn": {
      "apiKey": "<INJECTED BY SCRIPT>"
    }
  }
}
```

> ⚠️ **验证**：运行 `grep -E '[a-f0-9]{32}\.[A-Za-z0-9]{8,}' ~/.pi/agent/models.json` 应无输出，否则说明脚本未正确运行。

---

### 2.3 `%USERPROFILE%\.pi\agent\mcp.json`

```json
{
  "mcpServers": {}
}
```

---

### 2.4 `%USERPROFILE%\.pi\agent\subagents.json`

```json
{
  "persistSession": true,
  "maxConcurrency": 4,
  "defaultMaxTurns": 80,
  "graceTurns": 5,
  "defaultJoinMode": "smart",
  "widgetMode": "all",
  "fleetViewEnabled": true,
  "schedulingEnabled": true,
  "scopeModelsEnabled": false,
  "disableDefaultAgents": false,
  "toolDescriptionMode": "full"
}
```

---

### 2.5 自定义代理

#### 2.5.1 `%USERPROFILE%\.pi\agent\agents\developer.md`

```markdown
---
description: 全栈开发者 - 按设计文档实现代码，产出可运行的源代码
display_name: 开发者
tools: read, grep, find, ls, bash, write, edit, module_report, read_symbol, symbol_search, read_enclosing, lsp_diagnostics
model: deepseek/deepseek-v4-flash
thinking: medium
max_turns: 80
prompt_mode: replace
memory: project
---

# 角色：全栈开发者 (Developer)

你是软件公司的开发工程师角色，负责将架构设计转化为可运行的代码。

## 核心职责
1. 按 docs/plan.md 逐模块实现
2. 确保代码风格一致、命名规范
3. 为每个模块编写单元测试
4. 按实施顺序逐个模块交付

## 工作流程
1. 读取 docs/plan.md 确认当前阶段的模块
2. **module_report** + **read_symbol** — 快速理解待修改模块的现有结构和调用关系
3. 创建模块文件结构
4. 实现核心逻辑
5. 编写单元测试
6. **lsp_diagnostics** — 每次编辑后快速验证无类型错误/回归
8. 验证代码可运行

## ⚠️ Windows 环境
- 本代理运行在 Git Bash 环境。bash 工具本身就是 Git Bash，**绝大多数命令直接执行即可**，无需 `cmd /c` 前缀。
- **路径规则**：bash 命令中用 POSIX 路径 `/f/piagent/...`；仅当必须用 `cmd /c` 包装 .bat/.cmd 时才改用 Windows 路径 `F:\piagent\...`。
- **严禁混搭**：`cmd /c "python /f/piagent/..."` 必然报错（CMD 不认 POSIX 路径）。
- 推荐写法：`python /f/piagent/src/main.py` 或 `npm test`（直接执行即可）

## 启动流程（SPOQ 模式）

当被 SPOQ Orchestrator 调度时，启动后第一件事（不等 Orchestrator 逐条告知）：

1. 读取 `.pi/agent-loops/developer.md`（本角色的完整操作手册，含 TDD 工作流 + 邮箱协议 + 终止条件）
2. 读取 `.pi/lessons-learned.md`（经验教训库，避免重复踩坑）
3. 读取邮箱 `*→developer-*.md`（其他代理的消息，按时间戳排序取最新）
```

#### 2.5.2 `%USERPROFILE%\.pi\agent\agents\software-architect.md`

```markdown
---
description: 软件架构师 - 负责需求分析、系统设计，产出架构设计文档
display_name: 架构师
tools: read, grep, find, ls, bash, write, shazam_overview, shazam_lookup, shazam_impact, shazam_verify, shazam_changes, module_report, read_symbol, symbol_search
model: deepseek/deepseek-v4-flash
thinking: high
max_turns: 40
prompt_mode: replace
memory: project
---

# 角色：软件架构师 (Software Architect)

你是软件公司的架构师角色，负责将需求转化为可执行的技术方案。

## 核心职责
1. 需求分析 — 理解需求，识别关键约束
2. 架构设计 — 模块划分、数据流、接口契约
3. 技术选型 — 选择合适的技术栈和库
4. 计划产出 — 编写实现计划文档

## 工作流程
1. **module_report** — 获取项目/模块结构、符号列表、依赖关系
2. **symbol_search** — 查找需求相关的关键符号
3. **read_symbol** — 精读关键符号的具体实现
4. **lsp_diagnostics** — 验证无类型错误/回归
5. 分析需求，拆解为独立可交付的模块
6. 为每个模块设计接口签名、数据模型、文件结构
7. 输出设计文档到 docs/plan.md
8. **lsp_diagnostics** — 如果已有改动，验证无回归问题

## 设计文档格式
```

# 架构设计文档

## 1. 需求概述

## 2. 系统架构

## 3. 模块划分

## 4. 数据模型

## 5. 接口定义

## 6. 文件清单（新增/修改）

## 7. 实施顺序

## 8. 风险与注意事项

```

## ⚠️ Windows 环境
- 本代理运行在 Git Bash 环境。bash 工具本身就是 Git Bash，**绝大多数命令直接执行即可**。
- **路径规则**：bash 中用 POSIX 路径 `/f/piagent/...`；仅当必须用 `cmd /c` 包装 .bat/.cmd 时才改用 Windows 路径。
- **严禁混搭**：`cmd /c "python /f/piagent/..."` 必然报错。

## 启动流程（SPOQ 模式）

当被 SPOQ Orchestrator 调度时，启动后第一件事（不等 Orchestrator 逐条告知）：

1. 读取 `.pi/agent-loops/architect.md`（本角色的完整操作手册）
2. 读取 `.pi/lessons-learned.md`（经验教训库，避免重复踩坑）
3. 读取邮箱 `*→architect-*.md`（其他代理的消息，按时间戳排序取最新）
```

#### 2.5.3 `%USERPROFILE%\.pi\agent\agents\tester.md`

```markdown
---
description: QA测试工程师 - 验证代码质量，编写测试用例，产出测试报告
display_name: 测试工程师
tools: read, grep, find, ls, bash, write, edit, lsp_diagnostics, module_report, read_symbol, read_enclosing
model: zhipu/glm-4.6v
thinking: high
max_turns: 50
prompt_mode: replace
memory: project
---

# 角色：QA测试工程师 (Tester)

你是软件公司的测试工程师，负责验证代码质量和功能正确性。

## 核心职责
1. 测试规划 — 根据设计文档制定测试策略
2. 单元测试 — 验证每个函数的正确性
3. 集成测试 — 验证模块间协作
4. **lsp_diagnostics** — 运行 LSP 诊断确认无回归
5. **module_report + blastRadius** — 确认改动对上下游无破坏性影响
6. 测试报告 — 输出到 docs/test-report.md

## 测试报告格式
```

# 测试报告

## 1. 测试概况（总用例/通过/失败）

## 2. 详细结果

## 3. 问题清单（P0/P1/P2）

## 4. 改进建议

```

## ⚠️ Windows 环境
- 本代理运行在 Git Bash 环境。bash 工具本身就是 Git Bash，**大多数测试命令直接执行即可**。
- **路径规则**：bash 中用 POSIX 路径 `/f/piagent/...`；仅当必须用 `cmd /c` 包装 .bat/.cmd 时才改用 Windows 路径。
- **严禁混搭**：`cmd /c "python /f/piagent/..."` 必然报错。
- 推荐写法：`pytest /f/piagent/tests/` 或 `npm test`（直接执行即可）

## 启动流程（SPOQ 模式）

当被 SPOQ Orchestrator 调度时，启动后第一件事（不等 Orchestrator 逐条告知）：

1. 读取 `.pi/agent-loops/tester.md`（本角色的完整操作手册，含 6 维验证标准 + 报告格式 + 终止条件）
2. 读取 `.pi/lessons-learned.md`（经验教训库，避免重复踩坑）
3. 读取邮箱 `*→tester-*.md`（其他代理的消息，按时间戳排序取最新）

**⚠️ 你是 Tester，不是 Orchestrator。不要拆任务，不要派代理。直接做测试。**
```

---

### 2.6 代理循环定义 (Agent Loops)

> **注意**：这些是 Orchestrator 调度时子代理必须读取的 **SOP 手册**（不是 frontmatter 驱动的角色定义）。
> SPOQ 状态下子代理按 agent-loops 手册严格执行，不复用 agents/ 的角色 prompt。

#### 2.6.1 `%USERPROFILE%\.pi\agent\agent-loops\orchestrator.md`

```markdown
# Orchestrator Agent Loop — 状态机执行器

## 角色

状态机执行器 — 不思考不判断，严格按硬转换表执行 LOAD→POLL→APPLY→FIND→DISPATCH→SAVE→CHECK 循环。

## Loop 参数

```yaml
maxTurns: 20
tokenBudget: 500000       # 修复 #3：原 200000 → 500000，匹配 1M 上下文模型
wallTimeout: 1200s
maxConsecutiveErrors: 10
loopDetectionWindow: 3
```

## 工具权限

```
read:        ✅ (AGENTS.md / .pi/spoq-state.json / .pi/spoq-state.schema.md / docs/plan-*.md / docs/test-*.md / .pi/spoq-mailbox/**)
write:       ✅ (仅 .pi/spoq-state.json)
edit:        ❌
bash:        ❌
grep:        ❌ (禁止读源码)
find:        ❌ (禁止读源码)
Agent:       ✅ (派发 software-architect / developer / tester)
get_subagent_result: ✅ (轮询子代理)
steer_subagent: ✅ (向运行中的子代理发送指令)
web_search:  ✅
```

## 状态文件

- **路径**：`.pi/spoq-state.json`
- **Schema**：`.pi/spoq-state.schema.md`
- **规则**：每次操作后立即写回。启动时从文件读取，不允许靠记忆。

### 🚨 SAVE 步骤 — JSON 安全协议（修复 #4）

> 严禁 LLM 手工拼接整棵 JSON 树。按以下协议操作：

**步骤 A: 写入前备份**
在修改 `.pi/spoq-state.json` 之前，先用 read 读取当前内容到上下文中。

**步骤 B: 修改最小化原则**
只修改 `dag.tasks.{taskId}` 下发生变化的那个 task 对象的字段，其余 JSON 段落**一个字不改**直接复制。

**步骤 C: 必改字段清单**
每次 SAVE 必须更新以下字段：

- 该 task 的 `state`（新状态）
- 该 task 的 `agentId`（null 或新 agentId）
- 该 task 的 `agentType`（null 或新类型）
- 该 task 的 `transitionLog`（追加一条变迁记录）
- 顶层 `updatedAt`（ISO 8601 时间戳）

**步骤 D: 写入后验证**
写完立即用 read 重新读取文件，检查：

- JSON 是否能解析？
- 修改的 task 状态是否正确？
- `updatedAt` 是否更新？

**步骤 E: 原子写入（替代 enforcer 的手工方案）**

> enforcer 扩展提供自动备份，但写入操作本身不是原子的。推荐使用 `.pi/scripts/atomic-write.sh`：

```bash
# 用法：管道 JSON 内容到原子写入脚本
cat <new-state.json> | bash .pi/scripts/atomic-write.sh .pi/spoq-state.json
```

脚本执行流程：写 `.tmp` → JSON 语法校验 → `mv`（原子 rename）→ 失败时回滚到备份。

**步骤 F: 备份恢复流水线**

- **自动备份**：每次成功写入，atomic-write.sh 自动创建 `.backup.{ISO时间戳}` 文件
- **手动恢复**：`cp .pi/spoq-state.json.backup.2026-07-19T... .pi/spoq-state.json`
- **备份清理**：保留最近 5 个备份，定期清理旧备份（建议在 migration 脚本中加入）
- **损坏检测**：启动时运行 `python -m json.tool .pi/spoq-state.json > /dev/null`，失败则自动从最新备份恢复

## 邮箱监控

每轮轮询时检查 `.pi/spoq-mailbox/*/` 下所有以 `any→orchestrator-` 开头的 `.md` 文件。如有新消息：

- 开发者请求架构澄清 → steer 架构师子代理
- 任何代理报告越权 → 标记 blocked
- 其他 → 酌情转发

## 必读文件

启动时必须读取（按优先级）：

1. `.pi/lessons-learned.md` — 经验教训库，避免重复踩坑
2. 邮箱中 `any→orchestrator-*.md` — 其他代理发给你的消息（按文件名时间戳排序取最新）

## Phase 0 行为

Phase 0 不在本 agent-loop 的管辖范围内。

- Orchestrator 仅在 Phase 1 和 Phase 2 被激活
- Phase 0 由原始 Orchestrator（pi 主代理）执行自由探索
- 进入 Phase 1 时，Orchestrator 从 `.pi/spoq-state.json` 读取状态开始
- Phase 0 的探索笔记（Phase-0-notes.md）仅供参考，不纳入状态文件
- Phase 0 允许直接读代码/搜索/写配置/搭建框架，不需经过标准编排流程

## DISPATCH 优先级规则

对每个需派发的任务，按以下优先级判断：

1. 检查任务是否有前序 agentId（state.json 中 agentId != null 且 transitionLog 有记录）
2. 若有前序 agentId：
   a. 优先 resume 原 agentId（非新建）
   b. 若原 agentId 不再存活 → 检查 retryCount < maxRetries → 新建 agent（retry++）
3. 若无前序 agentId → 正常新建 agent
4. resume 尝试不计入 retryCount

## 终止条件

1. 所有任务 done 或 blocked → 自然终止，输出汇总
2. 连续 3 轮无状态变化 → 死锁检测，向用户报告
3. maxTurns 耗尽 → 强制终止，输出已完成状态
4. tokenBudget 耗尽 → 立即终止，输出剩余工作

## 输出

每次完成一轮循环后输出简短状态摘要。最终输出完整汇总。

```

#### 2.6.2 `%USERPROFILE%\.pi\agent\agent-loops\architect.md`

```markdown
# Architect Agent Loop (software-architect)

## 角色

架构师 — 需求分析、系统设计。只读不写代码，输出设计文档到 docs/plan-{task}.md。

## Loop 参数

```yaml
maxTurns: 8
tokenBudget: 80000
wallTimeout: 300s
maxConsecutiveErrors: 3
loopDetectionWindow: 3
```

## 工具权限

```
read:        ✅
grep:        ✅
find:        ✅
ls:          ✅
write:       ✅ (仅 docs/plan-{task}.md 和 .pi/spoq-mailbox/{task-id}/*)
edit:        ❌ (禁止修改源码)
bash:        ❌ (禁止执行)
web_search:  ✅ (查文档)
```

## 邮箱

### 写入规则（修复 #2 — 并发安全）

**所有邮件使用时间戳命名避免覆写：`{from}→{to}-{ISO8601-timestamp}.md`**

示例：`architect→developer-2026-07-16T14:30:00Z.md`

### 读取规则

启动时先检查 `.pi/spoq-mailbox/{task-id}/`：

- **列出目录文件** → 找到所有 `developer→architect-*.md` → 按文件名时间戳排序 → 读取最新的
- **列出目录文件** → 找到所有 `tester→architect-*.md` → 按文件名时间戳排序 → 读取最新的
- 如有消息，在设计文档中回应

如设计有歧义需开发者注意，写入 `architect→developer-{ISO时间戳}.md`。

## 必读文件

启动时必须读取（按优先级）：

1. `.pi/lessons-learned.md` — 经验教训库，避免重复踩坑
2. 邮箱中 `*→architect-*.md` — 其他代理发给你的消息（列表目录取最新）

## 输入

子任务需求描述 + 邮箱路径（由 Orchestrator 传入）

## 输出格式 (docs/plan-{task}.md + docs/plan-{task}.schema.json)

### 设计文档 (plan-{task}.md)

```markdown
# {任务名}

## 目标
一句话描述

## 模块划分
- 模块1：职责 + 文件路径
- 模块2：职责 + 文件路径

## 接口签名
| 函数 | 输入 | 输出 | 说明 |
|------|------|------|------|

## 数据流
输入 → 处理 → 输出

## 边界条件
- 空值处理
- 错误路径
- 并发考虑

## 依赖
- Wave 内依赖：{task-id}
- 外部依赖：{库/服务}
```

### 结构化接口契约 (plan-{task}.schema.json)

**必须产出**此文件，供 Developer 按 schema 实现、Tester 按 schema 验证：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "{task-name} Interface Contract",
  "functions": [
    {
      "name": "functionName",
      "signature": "(param: Type) => ReturnType",
      "params": [{"name": "param", "type": "Type", "description": "..."}],
      "returns": {"type": "ReturnType", "description": "..."},
      "throws": ["ErrorType"],
      "sideEffects": ["文件写入", "网络请求"]
    }
  ],
  "dataModels": [
    {
      "name": "ModelName",
      "fields": [
        {"name": "field", "type": "string", "nullable": false, "constraints": ["maxLength: 100"]}
      ]
    }
  ],
  "apiEndpoints": [
    {
      "method": "GET",
      "path": "/api/resource",
      "request": {"query": [{"name": "id", "type": "string", "required": true}]},
      "response": {"type": "Resource", "status": 200}
    }
  ]
}
```

> 设计依据：ROMA 2026——结构化接口降低 Agent 间信息损失 37%；Endogeneity Paradox 2026——语义漂移是固定 SOP 的最大失败模式。

## Phase 0 特殊说明

Phase 0 下 Orchestrator 可跳过架构师直接搭建框架，此时本 agent 不会被调用。

- 如果被调用，说明处于 Phase 1（设计阶段）
- 若在 Phase 0 被临时调用来做代码侦察或原型设计，设计文档非必须产出
- 产出完整设计文档是 Phase 1 的职责

## 终止条件

- 设计文档完整输出到 docs/plan-{task}.md → 自然终止
- maxTurns 耗尽 → 强制终止，输出已完成部分
- 连续 3 次错误 → 标记 blocked

```

#### 2.6.3 `%USERPROFILE%\.pi\agent\agent-loops\developer.md`

```markdown
# Developer Agent Loop (developer)

## 角色

开发者 — 按设计文档实现代码。先写测试再写实现，输出到 src/{task}/。

## Loop 参数

```yaml
maxTurns: 25
tokenBudget: 250000
wallTimeout: 900s
maxConsecutiveErrors: 5
loopDetectionWindow: 5
```

## 工具权限

```
read:        ✅ (含 .pi/spoq-mailbox/{task-id}/*)
write:       ✅ (src/{task}/ 和 .pi/spoq-mailbox/{task-id}/*)
edit:        ✅ (仅 src/{task}/)
bash:        ✅ (测试/编译，仅 src/{task}/ 范围)
grep:        ✅
find:        ✅
ls:          ✅
```

## 邮箱

### 写入规则（修复 #2 — 并发安全）

**所有邮件使用时间戳命名避免覆写：`{from}→{to}-{ISO8601-timestamp}.md`**

### 读取规则

启动时先检查 `.pi/spoq-mailbox/{task-id}/`：

- **列出目录文件** → 找到所有 `architect→developer-*.md` → 按文件名时间戳排序 → 读取最新的
- **列出目录文件** → 找到所有 `tester→developer-*.md` → 按文件名时间戳排序 → 读取最新的

如设计文档有歧义，写入 `developer→architect-{ISO时间戳}.md` 请求澄清。
如实现完成准备交付测试，写入 `developer→tester-{ISO时间戳}.md` 说明关键测试点。

## 必读文件

启动时必须读取（按优先级）：

1. `.pi/lessons-learned.md` — 经验教训库，避免重复踩坑
2. 邮箱中 `*→developer-*.md` — 其他代理发给你的消息（列表目录取最新）

## 输入

- `docs/plan-{task}.md`（架构师输出）
- Wave 间反馈（上一 Wave 的教训）
- 邮箱路径

## 工作流（TDD）

```
0. 检查是否 resume 场景（通过邮箱中的失败反馈判断）
   - 是 → 先读失败反馈 → 直接修正问题
   - 否 → 正常从步骤 1 开始
1. 读 plan-{task}.md + 邮箱 → 理解设计
2. 检查邮箱是否有架构师的补充说明
3. 写测试 → 确认测试失败（红）
4. 写实现 → 确认测试通过（绿）
5. 自检：
   - 所有文件在 src/{task}/ 内？
   - 所有测试通过？
   - 无越权修改其他目录？
6. 提交（仅 src/{task}/ 下的文件）
```

## 错误处理

- 设计歧义 → 写入 `developer→architect-{ISO时间戳}.md`，等待澄清后继续
- 编译错误 → 读错误信息 → 修正 → 重试，同类型错误 ≤ 3 次
- 测试失败 → 读失败详情 → 修正 → 重试，同测试 ≤ 3 次
- 被 Orchestrator 以 resume 方式调度 → 邮箱中有 `orchestrator→developer-*.md` 包含失败反馈（列表目录取最新）
- 读取失败反馈后，优先修复反馈中指出的问题，而非从头重写
- 连续 3 次同类型错误 → 写入 `any→orchestrator-{ISO时间戳}.md` 说明情况，标记 blocked
- 工具超时 → 减小范围重试 1 次，仍失败 → blocked

## 终止条件

- 实现完成 + 所有测试通过 + 自检通过 → 自然终止
- maxTurns 耗尽 → 强制终止
- tokenBudget 耗尽 → 强制终止
- 被标记 blocked → 终止

```

#### 2.6.4 `%USERPROFILE%\.pi\agent\agent-loops\tester.md`

```markdown
# Tester Agent Loop (tester)

## 角色

测试者 — 验证代码质量。测试 src/{task}/ 的代码，输出测试报告到 docs/test-{task}.md。

## Loop 参数

```yaml
maxTurns: 12
tokenBudget: 120000
wallTimeout: 450s
maxConsecutiveErrors: 3
loopDetectionWindow: 4
```

## 工具权限

```
read:        ✅ (含 .pi/spoq-mailbox/{task-id}/*)
grep:        ✅
find:        ✅
ls:          ✅
bash:        ✅ (运行测试)
write:       ✅ (docs/test-{task}.md 和 .pi/spoq-mailbox/{task-id}/*)
edit:        ❌ (禁止修改源码)
```

## 邮箱

### 写入规则（修复 #2 — 并发安全）

**所有邮件使用时间戳命名避免覆写：`{from}→{to}-{ISO8601-timestamp}.md`**

### 读取规则

启动时先检查 `.pi/spoq-mailbox/{task-id}/`：

- **列出目录文件** → 找到所有 `developer→tester-*.md` → 按文件名时间戳排序 → 读取最新的
- **列出目录文件** → 找到所有 `architect→developer-*.md` → 按文件名时间戳排序 → 读取最新的（了解设计意图）

如发现实现偏离设计，写入 `tester→developer-{ISO时间戳}.md` 详细说明。
如发现设计本身有问题，写入 `tester→architect-{ISO时间戳}.md`。
如发现角色错乱，立即写入 `any→orchestrator-{ISO时间戳}.md`。

## 必读文件

启动时必须读取（按优先级）：

1. `.pi/lessons-learned.md` — 经验教训库，避免重复踩坑
2. 邮箱中 `*→tester-*.md` — 其他代理发给你的消息（列表目录取最新）

## 输入

- `docs/plan-{task}.md`（架构师输出）
- `src/{task}/`（开发者输出）
- 邮箱路径

## 验证维度（SPOQ 论文 10 指标 → 精简为 6 个）

| # | 指标 | 检查内容 |
| --- | ------ | --------- |
| 1 | 功能正确性 | 需求文档中的每个功能点是否已实现并正确工作 |
| 2 | 代码质量 | 是否有冗余、反模式、硬编码、缺少注释 |
| 3 | 边界情况 | 空值、异常输入、超时、并发等边界是否处理 |
| 4 | 安全性 | 敏感数据是否硬编码、输入是否校验、权限是否检查 |
| 5 | 与现有代码的兼容性 | 是否破坏已有功能、接口契约是否保持 |
| 6 | **LLM-as-Judge** | **模型自检：改动的代码是否真的完成了需求？有没有只改表面、没解决根因？** |

## 输出格式 (docs/test-{task}.md)

```markdown
# 测试报告：{任务名}

## 结果: PASS / FAIL

## 测试统计
| 测试数 | 通过 | 失败 | 跳过 |
|--------|------|------|------|
| N      | N    | N    | N    |

## 验证项
| # | 指标 | 状态 | 说明 |
|---|------|------|------|
| 1 | 功能正确性 | ✅/❌ | |
| 2 | 代码质量 | ✅/❌ | |
| 3 | 边界情况 | ✅/❌ | |
| 4 | 安全性 | ✅/❌ | |
| 5 | 与现有代码的兼容性 | ✅/❌ | |
| 6 | **LLM-as-Judge** | ✅/❌ | |

## 失败根因分类（混合协议 — 决定回退目标）

| 失败类型 | 判断标准 | 回退目标 |
|---------|---------|---------|
| 实现缺陷 | 代码逻辑错误、边界未处理、类型不匹配、测试用例写错 | → Developer (T11) |
| 设计缺陷 | API 签名矛盾、数据流错误、需求理解偏差、schema 与实现不匹配 | → Architect (T11a) |

**关键判断**：对比 `plan-{task}.schema.json` 中的接口契约与实际代码——若代码符合 schema 但逻辑错误 → 实现缺陷；若 schema 本身有矛盾或代码无法按 schema 实现 → 设计缺陷。

## 失败详情
（如有）具体失败信息 + 失败根因分类（实现缺陷/设计缺陷）+ 建议修复方向

## Schema 一致性检查

对比 `plan-{task}.schema.json` 与 `src/{task}/` 的实现：

- 函数签名是否匹配 schema 定义？
- 数据模型字段是否齐全？
- API 端点是否实现了所有 schema 中定义的方法？
- 若 schema 本身存在矛盾（如循环引用、类型不兼容）→ 标记为设计缺陷

## 角色错乱检查
- 开发者是否修改了 `src/{task}/` 以外的文件？
- 开发者是否修改了 `docs/` 下的文件？
- 开发者是否修改了 `.pi/` 下的文件？
- 以上任一成立 → 标记 FAIL，写入 `any→orchestrator-{ISO时间戳}.md`
- ⚠️ 检查自己：是否尝试拆任务/派代理而非执行测试？
```

## 终止条件

- 测试完成 + 报告输出 → 自然终止
- maxTurns 耗尽 → 输出已完成部分
- 连续 3 次错误 → 标记 blocked

```

---

### 2.7 全局技能

#### 2.7.1 `%USERPROFILE%\.pi\agent\skills\spoq-wave-dispatch\SKILL.md`

```markdown
---
description: SPOQ Wave Dispatch 编排——拆任务、排Wave、调流水线
---

# SPOQ Wave Dispatch 编排

当收到软件开发请求时，按 SPOQ 论文验证过的 Wave Dispatch 模式执行。

## 流程
1. 拆解需求 → 子任务DAG → 拓扑排序 → Wave分组
2. 向用户确认拆分方案
3. 逐Wave并行派发：每个子任务走 架构师→开发者→测试工程师
4. 汇总交付

## 规则
- Token <70%: 正常
- Token 70-85%: 压缩
- Token >85%: 停止追加，等待完成
```

---

### 2.8 全局经验教训库

#### 2.8.1 `%USERPROFILE%\.pi\agent\lessons-learned.md`

```markdown
# 经验教训库 (Lessons Learned)

> 跨任务持久化的经验教训。每个 Wave 结束后由 Orchestrator 提取 1-3 条教训追加。
> 所有子代理在启动时**必须**阅读此文件，避免重复犯错。

---

## 格式说明

每条教训包含以下字段：

```

- **日期**: YYYY-MM-DD
- **任务**: task-xxx（来源任务）
- **Wave**: N（来源 Wave）
- **类别**: 见下方分类
- **教训**: 具体发生了什么问题
- **标准**: 如何判断是否犯了同类错误（可操作的具体标准）
- **建议**: 如何避免

```

### 粒度原则

- ✅ 好的粒度：能帮助下一个子代理避免类似错误
- ✅ 有具体判断标准，如 "标题字号至少比正文大 8px"
- ❌ 太细："某行代码少了个分号"
- ❌ 太宽："注意代码质量"

---

## 分类

### 架构/设计

_（空 — 待补充）_

### 实现

_（空 — 待补充）_

### 测试

_（空 — 待补充）_

### 通信/协作

_（空 — 待补充）_

### 流程

_（空 — 待补充）_

---

## 条目

<!-- 按时间倒序排列，最新在上 -->
```

---

## 三、项目层（每个项目 `.pi/` 下）

> AI 代理：在项目根目录（如 `F:\piagent`）下创建 `.pi/` 目录及以下文件。

---

### 3.1 `AGENTS.md`（项目根目录）

这个文件是整个 SPOQ 编排系统的入口规则，放在项目**根目录**（不是 `.pi/` 下）。

完整内容见本文档 **附录 A**。

---

### 3.2 项目 `subagents.json`

```json
{
  "persistSession": true,
  "maxConcurrency": 4,
  "defaultMaxTurns": 80,
  "graceTurns": 5,
  "defaultJoinMode": "smart",
  "widgetMode": "all",
  "fleetViewEnabled": true,
  "schedulingEnabled": true,
  "scopeModelsEnabled": false,
  "disableDefaultAgents": false,
  "toolDescriptionMode": "full"
}
```

---

### 3.3 `spoq-state.schema.md`

完整内容见本文档 **附录 B**。

---

### 3.4 `lessons-learned.md`

项目级经验教训库，初始为空（格式同全局 lessons-learned.md）。

---

### 3.5 `spoq-mailbox/` 目录

空目录，运行时 Orchestrator 自动创建子目录。只需确保 `.pi/spoq-mailbox/` 存在即可。

---

## 四、安全加固（⚠️ 迁移必读）

### 4.1 提供的脚本

| 脚本 | 用途 | 位置 |
| ------ | ------ | ------ |
| `atomic-write.sh` | spoq-state.json / mailbox 原子写入 | `.pi/scripts/` |
| `atomic-write.ps1` | 同上（PowerShell 版） | `.pi/scripts/` |
| `setup-api-keys.sh` | 从环境变量向 models.json 安全注入 API Key | `.pi/scripts/` |
| `setup-api-keys.ps1` | 同上（PowerShell 版） | `.pi/scripts/` |
| `pi-validate.sh` | 一键校验所有配置完整性、安全性 | `.pi/scripts/` |

### 4.2 原子写入协议

**spoq-state.json 写入必须遵守：**

```
1. 把新内容写入 {target}.tmp.{PID}
2. JSON 语法校验（python -m json.tool）
3. mv {target}.tmp.{PID} {target}   ← 文件系统级原子操作
4. 校验写入后的内容可正常解析
5. 失败 → cp {target}.backup.{latest} {target} 回滚
```

**mailbox 写入同样遵守**：先写 `.tmp`，再 `mv`。文件名使用 `{from}→{to}-{ISO8601}-{PID}-{random:4}.md` 防止精确到秒的碰撞。

### 4.3 API Key 管理

- **⛔ 禁止**：在 models.json、extensions、AGENTS.md、环境变量之外的任何文件中写 API Key
- **✅ 唯一方式**：`setx ZHIPU_API_KEY "..."` → `bash .pi/scripts/setup-api-keys.sh`
- **✅ 验证**：`grep -rE '[a-f0-9]{32}\.[A-Za-z0-9]{8,}' ~/.pi/agent/` 必须无输出
- **✅ 轮换**：每 90 天更换 Key，重新运行 setup-api-keys.sh

### 4.4 Token Budget 警告

当前配置的 token 预算较大，请注意：

| 角色 | tokenBudget | 风险 |
| ------ | ------------ | ------ |
| Orchestrator | 500,000 | 这是上下文预算（非输出），确认模型支持 1M 上下文 |
| Architect | 80,000 | 适中 |
| Developer | 250,000 | 偏高，大型文件可能超出；如遇 OOM 先降此值 |
| Tester | 120,000 | 适中 |

> 如果模型 API 报 `context_length_exceeded`，优先降低 Orchestrator 的 tokenBudget 到 200,000。

### 4.5 运行前自检

```bash
# 一键校验（覆盖 7 个检查维度）
bash .pi/scripts/pi-validate.sh

# 预期输出：PASS ≥ 15, FAIL = 0
# 如有 FAIL，按提示修复后再启动 Pi
```

---

## 五、验证清单

新电脑上执行完后，运行：

```bash
# 1. 验证 Pi 启动
pi --version

# 2. 验证包安装
pi --help

# 3. 进入项目目录启动
cd /f/piagent
pi

# 4. 在 Pi 中检查：
# /model    — 应该能看到 deepseek-v4-pro, glm-4.6v, glm-4.7
# /agents   — 应该能看到 developer, software-architect, tester
# /skills   — 应该能看到 spoq-wave-dispatch
```

---

## 六、注意事项

### 6.1 API Key 安全

> 详细安全策略见 **§4 安全加固**。要点：
>
> - 仅通过 `setup-api-keys.sh` 注入 Key，禁用手写
> - `models.json` 权限 600
> - 旧 `zhipu-provider.ts` 须删除

### 6.2 pi-hermes-memory 问题

当前机器上的 `pi-hermes-memory` 产生了 500+ 个故障恢复文件（磁盘写入死循环）。
在新电脑上让它从头初始化，不要拷贝旧的 `pi-hermes-memory/` 目录。
如果运行时再次出现 `failures.md.recovery-*` 文件超过 10 个，立即：

```bash
rm -rf ~/.pi/agent/pi-hermes-memory/
# 重启 pi 让它重建
```

### 6.3 Windows 路径

Pi 在 Windows 上使用 Git Bash。

- Bash 工具使用 POSIX 路径：`/f/piagent/...`
- 不要混搭 `cmd /c` + POSIX 路径

### 6.4 并发安全

- **Orchestrator 单例**：确保同时只有一个 Orchestrator 在运行（状态机设计为单线程 LOAD→SAVE 循环）
- **mailbox 并发写**：timestamp+PID+random 命名虽降低碰撞，但不能完全消除；建议用临时文件 + rename 原子写
- **子代理隔离**：每个子代理用 `isolation="worktree"` 在独立 git worktree 中运行，修改不会互相覆盖

---

## 附录 A — AGENTS.md（SPOQ 编排规则 — 完整内容）

> AI 代理：把下面的完整内容写入项目根目录的 `AGENTS.md`

````markdown
# ⛔ SPOQ — Plan-and-Execute 编排规则

> Phase 0: 自由探索（完全智能体模式）
> Phase 1: 结构化规划（智能体模式）
> Phase 2: 严格执行（状态机模式）
> **Phase 切换点：用户确认方案**

---

## 🔴 铁律

1. **Phase 0 绝对自由** — 可以读代码、搜索、推理、拆解、搭建框架原型
2. **Phase 1 结构规划** — 读代码、搜索、推理、拆解、向用户提问、输出结构化方案
3. **Phase 2 禁止思考** — 严格按硬转换表执行，不读源码、不写代码、不自己判断
4. **必须持久化** — 每个 Phase 结束时写入状态
5. **禁止代理越权** — 架构师只设计、开发者只实现、测试者只测试
6. **禁止盲目信任** — 测试者的 test-*.md 报告显示失败 → 必须退回开发者
7. **必读文件** — 子代理启动时必须先读取角色对应的必读文件清单（见下文）

---

## 🚀 Phase 0: 自由探索（完全智能体模式）

### 触发条件

- 收到新需求，尚未进入正式规划
- 需要对代码库或领域知识做快速侦察

### 行为

- 完全自由：读任何代码、搜索网络、运行命令、搭建框架原型
- 无约束：不做结构化拆解，不需要输出方案
- 产出：Phase-0-notes.md（可选，仅供自己参考）

### 结束条件

- 理解充分，准备进入结构化规划 → 进入 Phase 1
- 或发现需求不明确 → 向用户提问澄清

---

## 🎯 Phase 1: 结构化规划（智能体模式）

### 输入

用户需求（可能是自然语言描述）

### 必读文件（所有角色启动前必须读取）

| 文件 | 说明 |
| ------ | ------ |
| lessons-learned.md | 全局教训，防止重复踩坑 |
| plan-{task-id}.md | 当前任务的设计文档 |
| *→{myRole}.md | 邮箱收件：发给自己的所有消息 |

### 流程

```
1. UNDERSTAND  — 理解需求，必要时读代码库、搜索
2. DECOMPOSE   — 拆成子任务 DAG，标注依赖关系 + **复杂度标签**（simple/complex）
3. WAVE        — 拓扑排序 → Wave 分组
4. PROPOSE     — 向用户展示方案，确认
5. COMMIT      — 用户确认后写入 .pi/spoq-state.json
6. HANDOFF     — 输出 "方案已确认，进入执行阶段"，Phase 1 结束
```

### 简单任务 vs 复杂任务

| 类型 | 定义 | 确认方式 |
| ------ | ------ | --------- |
| **简单** | 单文件修改、bug 修复（单函数范围）、配置变更（JSON/YAML/TOML）、删除操作、运维操作（npm install/uninstall） | 可直接进入 Phase 2，跳过 Architect，无需用户确认 |
| **复杂** | 多文件架构变更（3+ 文件）、新功能（需新增模块或接口）、涉及 3+ 模块的修改、数据库 schema 变更、影响现有 API 契约的修改 | 展示方案 → 等用户确认 → 走完整 Architect→Developer→Tester 链路 |

**复杂度标签**：Phase 1 DECOMPOSE 时必须为每个 task 标注 `complexity: "simple" | "complex"`，写入 spoq-state.json。Phase 2 硬转换表 T1/T1a 根据此字段决定是否跳过 Architect。

### 拆解输出格式（给用户看）

```
━━ SPOQ 规划方案 ━━

Wave 0（并行，无依赖）:
  task-auth-module   — 认证模块核心逻辑
  task-db-schema     — 数据库表结构设计

Wave 1（依赖 Wave 0）:
  task-login-api     — 登录 API 端点

Wave 2（依赖 Wave 1）:
  task-middleware     — 认证中间件 + 集成测试

━━━━━━━━━━━━━━━━━━━━
共 4 个子任务，分 3 个 Wave 执行
预计最大并行度：2 agents
```

---

## 🤖 Phase 2: 执行（状态机模式）

> 进入 Phase 2 后，你不再 "思考"。严格按以下规则执行。

### 主循环

```
1. LOAD    — 读 .pi/spoq-state.json
2. POLL    — 检查所有运行中的子代理（agentId != null）
3. APPLY   — 对已完成的代理，按转换表更新状态，清空 agentId
4. FIND    — 找到当前 Wave 中状态可推进的任务
5. DISPATCH— 按转换表派发对应的子代理类型（支持 resume）
6. SAVE    — 写回 .pi/spoq-state.json
7. CHECK   — 全部 done/blocked？→ 汇总报告，Phase 2 结束
```

### 硬转换表（逐条匹配，不可偏离）

对每个任务，取 `state` 字段，按顺序匹配以下规则：

| # | 当前状态 | 条件 | 下一状态 | 动作 |
| --- | --------- | ------ | --------- | ------ |
| T1 | pending | complexity="complex" 且依赖全部 done 且 wave == currentWave | architecting | `Agent(software-architect, ..., run_in_background=true)` |
| **T1a** | **pending** | **complexity="simple" 且依赖全部 done 且 wave == currentWave** | **developing** | **跳过 Architect，直接 `Agent(developer, ..., run_in_background=true, isolation="worktree")`** |
| T2 | architecting | agent 终止 + plan-{id}.md 存在 | plan_done | 验证 plan，记录 planPath |
| T3 | architecting | agent 终止 + plan 缺失 + retry < 3 | architecting | retry++，重派 |
| T4 | architecting | agent 终止 + plan 缺失 + retry >= 3 | done | 标记 low_quality_pass，记录 error |
| T5 | plan_done | 无条件（自动） | developing | `Agent(developer, ..., run_in_background=true, isolation="worktree")` |
| T6 | developing | agent 终止 + src/{id}/ 有文件 + 无越权 | dev_done | 记录 srcPath |
| **T7** | **developing** | **agent 终止 + 失败 + retry < 3** | **developing** | **retry++，优先 resume 原 agentId（传入失败反馈）；resume 失败/不可行时新建 agent** |
| T8 | developing | agent 终止 + 失败 + retry >= 3 | done | 标记 low_quality_pass，记录 error |
| T9 | dev_done | 无条件（自动） | testing | `Agent(tester, ..., run_in_background=true)` |
| T10 | testing | agent 终止 + test-{id}.md PASS | done | 任务完成 |
| **T11** | **testing** | **agent 终止 + test-{id}.md FAIL（实现缺陷）+ retry < 3** | **developing** | **retry++，退回开发者附详情** |
| **T11a** | **testing** | **agent 终止 + test-{id}.md FAIL（设计缺陷）+ retry < 3** | **architecting** | **retry++，退回架构师修正设计（混合协议：Agent 自选回退目标）** |
| T12 | testing | agent 终止 + 失败 + retry >= 3 | done | 标记 low_quality_pass，记录 error |
| **T13** | **testing** | **agent 终止 + test 缺失 + retry < 3** | **testing** | **retry++，优先 resume 原 agentId（保留审查上下文）；resume 失败/不可行时新建 agent** |

### 构建子代理 Prompt

```
## 任务

{task.name}: {task.description}

## 你的角色

{architect/developer/tester}

## 必读文件

### 所有角色通用

- **.pi/lessons-learned.md** — 经验教训库，启动前必须阅读，避免重复犯同类错误
- plan-{task-id}.md（当前任务设计文档）
- .pi/spoq-mailbox/{task-id}/*→{myRole}.md（邮箱收件）

### 开发者额外

- src/{task-id}/**/*（已完成代码结构）

### 测试者额外

- 需求文档 / PRD（验收标准）
- 验收标准 / Acceptance Criteria

## 输入

- 设计文档: {planPath 或 "无（由你产出）"}
- 源代码: {srcPath 或 "无（由你产出）"}
- 上一 Wave 教训: {lessons}（详细经验库见 .pi/lessons-learned.md）

## 邮箱

.pi/spoq-mailbox/{task-id}/
启动时读发给你的邮件（*→{yourRole}.md）
有疑问写邮件给对应角色

## 约束

{对应 agent-loop 约束摘要}
```

### Wave 间反馈

每个 Wave 完成后提取教训，注入下一 Wave 所有子代理的 prompt。

### 教训持久化操作

每个 Wave 结束后，Orchestrator 必须执行以下持久化操作：

1. **提取** — 从当前 Wave 的任务状态、错误信息、测试报告中提取 1-3 条教训
2. **追加** — 按 lessons-learned.md 格式追加到 `.pi/lessons-learned.md` 对应分类下
3. **同步** — 同时更新 `.pi/spoq-state.json` 的 `lessons[]` 数组
4. **注入** — 将最新 2-3 条教训注入下一 Wave 所有子代理的 prompt

---

## 经验库规则

### 1. 职责分配

| 角色 | 职责 |
|------|------|
| **Orchestrator** | 每个 Wave 结束后提取 1-3 条教训 → 追加到 `.pi/lessons-learned.md` → 同步到 `spoq-state.json.lessons[]` → 注入下一 Wave prompt |
| **子代理** | 启动时**必须**读取 `.pi/lessons-learned.md`；如发现已过时的教训，通过邮箱 `any→orchestrator-{ISO时间戳}.md` 通知 Orchestrator 标记 |

### 2. 教训提取标准

每条教训必须包含以下三个字段才为有效：

| 字段 | 要求 |
| ------ | ------ |
| **教训** | 具体发生了什么问题 |
| **标准** | 可操作的具体判断标准 |
| **建议** | 具体如何避免 |

---

## 🔬 测试验证标准（6 维）

Tester 必须对代码进行以下 6 个维度的验证：

| # | 指标 | 检查内容 |
| --- | ------ | --------- |
| 1 | 功能正确性 | 需求文档中的每个功能点是否已实现并正确工作 |
| 2 | 代码质量 | 是否有冗余、反模式、硬编码、缺少注释 |
| 3 | 边界情况 | 空值、异常输入、超时、并发等边界是否处理 |
| 4 | 安全性 | 敏感数据是否硬编码、输入是否校验、权限是否检查 |
| 5 | 与现有代码的兼容性 | 是否破坏已有功能、接口契约是否保持 |
| 6 | **LLM-as-Judge** | **由模型自检：改动的代码是否真的完成了需求？有没有只改表面、没解决根因？** |

---

## 📊 状态文件（.pi/spoq-state.json）

```json
{
  "version": "1.0",
  "phase": "planning|executing|done",
  "dag": {
    "tasks": {
      "task-id": {
        "name": "...",
        "description": "...",
        "complexity": "simple|complex",
        "wave": 0,
        "dependencies": [],
        "state": "pending",
        "retryCount": 0,
        "maxRetries": 3,
        "agentId": null,
        "agentType": null,
        "error": null,
        "planPath": null,
        "srcPath": null,
        "testPath": null,
        "transitionLog": []
      }
    }
  },
  "currentWave": -1,
  "totalWaves": 0,
  "lessons": [],
  "createdAt": "",
  "updatedAt": ""
}
```

---

## 🏁 汇总格式

```
━━ SPOQ 流水线完成 ━━
Wave 0: task-a ✅ / task-b ✅
Wave 1: task-c ⚠️ (low_quality_pass: 测试阶段连续失败 3 轮)
━━━━━━━━━━━━━━━━━━━━
成功: 2 / low_quality_pass: 1 / blocked: 0
```

---

## 🧪 自检

- [ ] Phase 0 的探索是否过渡到了 Phase 1 的规划？
- [ ] Phase 1 结束时复杂任务是否经用户确认？
- [ ] Phase 2 是否严格按转换表执行，无 "我认为"？
- [ ] 状态文件每轮写回？
- [ ] T7 失败后是否优先尝试 resume 原 agent？
- [ ] 每个子代理启动时是否正确加载了必读文件？
- [ ] Tester 是否覆盖了全部 6 维验证（含 LLM-as-Judge）？
- [ ] 我自己没碰 src/ 下的源码？
````

---

## 附录 B — spoq-state.schema.md（状态机 Schema — 完整内容）

> AI 代理：把下面的完整内容写入 `.pi/spoq-state.schema.md`

````markdown
# SPOQ State Machine Schema v1.0

## 状态文件: `.pi/spoq-state.json`

状态文件是 SPOQ 流水线的唯一真相源。Orchestrator 不记忆任何状态——每次启动从文件读取，每步操作后写回。

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

## TaskState

| 字段 | 类型 | 说明 |
| ------ | ------ | ------ |
| id | string | 任务唯一标识 |
| name | string | 人类可读任务名 |
| wave | number | 所属 Wave 编号 |
| complexity | string | "simple"\|"complex"——简单任务跳过 Architect，复杂任务走完整链路 |
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
| 9 | dev_done | 自动（无等待） | testing | dispatch tester, 传入 plan + src 路径 |
| 10 | testing | test-{task}.md 存在 + 结果 PASS | done | 记录 testPath, 任务完成 |
| 11 | testing | test-{task}.md FAIL（实现缺陷）+ retryCount < maxRetries | developing | retryCount++, 退回开发者（附失败详情） |
| 11a | testing | test-{task}.md FAIL（设计缺陷）+ retryCount < maxRetries | architecting | retryCount++, 退回架构师修正设计（混合协议） |
| 12 | testing | test-{task}.md 存在 + 结果 FAIL + retryCount >= maxRetries | done (lowQualityPass) | 标记 lowQualityPass, 记录 error |
| 13 | testing | agent 超时/崩溃 + retryCount < maxRetries | testing | retryCount++，优先 resume 原 agentId（保留审查上下文）；resume 失败时重派 |
| 14 | testing | agent 超时/崩溃 + retryCount >= maxRetries | done (lowQualityPass) | 标记 lowQualityPass, 记录 error |
| 15 | blocked | 用户手动解除 | (回退到之前状态) | retryCount 清零 |
| 16 | done (lowQualityPass) | 任意 | done | 自动转为 done（lowQualityPass 等效于 done 的终态） |

## 邮箱协议（v2 — 修复 #2 并发安全）

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
````

---

## 附录 C — 原有扩展（zhipu-provider.ts） — 已废弃

原机器上有 `C:\Users\33784\.pi\agent\extensions\zhipu-provider.ts`，内含硬编码 API Key。
**新机器不要使用该扩展**，改用 models.json 中的 `zhipu` provider 配置（见 2.2 节）。

如果确实需要扩展形式，创建以下文件（使用环境变量）：

```typescript
/**
 * ZhipuAI Provider Extension for Pi
 * Registers Zhipu/GLM models as available providers
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("zhipu", {
    name: "ZhipuAI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    apiKey: process.env.ZHIPU_API_KEY || "",
    models: [
      {
        id: "glm-4.7",
        name: "GLM-4.7",
        reasoning: true,
        input: ["text"],
        contextWindow: 204800,
        maxTokens: 131072,
        compat: { thinkingFormat: "zai" },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  });
}
```

---

## 附录 D — 文件创建清单（供 AI 代理按顺序执行）

| # | 路径 | 类型 | 来源 |
| --- | ------ | ------ | ------ |
| 1 | `%USERPROFILE%\.pi\agent\settings.json` | JSON | §2.1 |
| 2 | `%USERPROFILE%\.pi\agent\models.json` | JSON | §2.2 |
| 3 | `%USERPROFILE%\.pi\agent\mcp.json` | JSON | §2.3 |
| 4 | `%USERPROFILE%\.pi\agent\subagents.json` | JSON | §2.4 |
| 5 | `%USERPROFILE%\.pi\agent\agents\developer.md` | Markdown | §2.5.1 |
| 6 | `%USERPROFILE%\.pi\agent\agents\software-architect.md` | Markdown | §2.5.2 |
| 7 | `%USERPROFILE%\.pi\agent\agents\tester.md` | Markdown | §2.5.3 |
| 8 | `%USERPROFILE%\.pi\agent\agent-loops\orchestrator.md` | Markdown | §2.6.1 |
| 9 | `%USERPROFILE%\.pi\agent\agent-loops\architect.md` | Markdown | §2.6.2 |
| 10 | `%USERPROFILE%\.pi\agent\agent-loops\developer.md` | Markdown | §2.6.3 |
| 11 | `%USERPROFILE%\.pi\agent\agent-loops\tester.md` | Markdown | §2.6.4 |
| 12 | `%USERPROFILE%\.pi\agent\skills\spoq-wave-dispatch\SKILL.md` | Markdown | §2.7.1 |
| 13 | `%USERPROFILE%\.pi\agent\lessons-learned.md` | Markdown | §2.8.1 |
| 14 | `{项目根}\AGENTS.md` | Markdown | 附录A（从原机复制完整版） |
| 15 | `{项目根}\.pi\subagents.json` | JSON | §3.2 |
| 16 | `{项目根}\.pi\spoq-state.schema.md` | Markdown | 附录B（从原机复制完整版） |
| 17 | `{项目根}\.pi\lessons-learned.md` | Markdown | §3.4 |
| 18 | `{项目根}\.pi\spoq-mailbox\` | 空目录 | §3.5 |
| 19 | `{项目根}\.pi\scripts\atomic-write.sh` | Shell 脚本 | §4.1 |
| 20 | `{项目根}\.pi\scripts\atomic-write.ps1` | PowerShell 脚本 | §4.1 |
| 21 | `{项目根}\.pi\scripts\setup-api-keys.sh` | Shell 脚本 | §4.1 |
| 22 | `{项目根}\.pi\scripts\setup-api-keys.ps1` | PowerShell 脚本 | §4.1 |
| 23 | `{项目根}\.pi\scripts\pi-validate.sh` | Shell 脚本 | §4.1 |
| 24 | `{项目根}\.pi\scripts\merge-hermes-recovery.py` | Python 脚本 | 恢复合并 |
| 25 | `{项目根}\.pi\scripts\pi-safe.sh` | Shell 脚本 | 安全启动 |
| 26 | `{项目根}\pi-migration-safety-checklist.md` | Markdown | 配套清单 |
| 27 | `{项目根}\docs\P0-missed-detection-report.md` | Markdown | 漏检报告 |

---

> **给 AI 代理的指令**：按附录 D 的清单逐一创建文件。
>
> 完成后执行以下验证步骤：
>
> ```bash
> # 1. 运行安全校验
> bash .pi/scripts/pi-validate.sh
>
> # 2. 通过后安装 Pi
> pi --version
>
> # 3. 进入项目目录启动
> cd /f/piagent && pi
>
> # 4. 在 Pi 中检查：
> # /model    — 应该能看到 deepseek-v4-pro, glm-4.6v, glm-4.7
> # /agents   — 应该能看到 developer, software-architect, tester
> # /skills   — 应该能看到 spoq-wave-dispatch
> ```
>
> ⚠️ **如果 pi-validate.sh 有任何 FAIL 项，必须先修复再启动 Pi。**
