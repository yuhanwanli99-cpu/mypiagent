# SPOQ SOP — 状态机驱动的 agents 集群标准作业流程

> 定位：本项目是一个普通 agent 集群节点，与 Claude Code / Hermes 等 CLI 同项目并存。
> 本 SOP 定义主代理（指挥官）如何把用户请求拆成固定角色流水线执行。
> 状态机是主代理单次任务内的"我正在哪一步"记忆假体，**不做项目级任务台账，不持久化到项目文件**（持久化靠 pi 自身 session 能力）。

---

## 0. 铁律

1. **不信任单 agent 处理多件事**——任何角色只做一件事，交接物是唯一通信手段。
2. **决策权不交给弱模型**——pro/flash 都只填 schema、提选项、执行；拍板权在：确定性规则 + 人工 Gate。
3. **判断权结构排除**——能在 schema 里排除的决策字段就不存在（如研究员的 decision 字段），不靠"提醒模型别做"。
4. **任务完成即清空**——DAG 全 done 或用户终止，状态机立即归零，不留痕迹给下一个请求。

---

## 1. 角色表（11 行 = 10 模型角色 + 测试执行无LLM）

| # | 层级 | 角色 | subagent_type | 模型 | 输入 | 交接物（输出） | 禁止 |
|---|---|---|---|---|---|---|---|
| 1 | L0 | **Router** | （主代理直接调分类，非子代理） | flash×3投票 | 用户原始输入 | 分类标签 DIRECT/PIPELINE/ESCALATE | 不裁决 |
| 2 | L1 | **需求分析师** | `requirement-analyst` | flash+max | 用户输入+Router标签 | **需求.md**：用户故事/验收标准/边界/非目标/**数据缺口清单** | 不许编造数据；缺口必填 |
| 3 | L1 | **检索员** | `searcher` | flash | 数据缺口清单+需求.md | **检索报告.md**：findings[] + gap_status | 禁止粘贴原文>200字；无来源=进gap |
| 🚪 | Gate1 | 人工 | — | — | 需求.md | 确认/打回 | — |
| 4 | L2 | **架构师** | `architect` | pro | 需求.md | **架构.md**：选型选项+取舍理由+模块划分+每模块tier | 不许自己定论；数据不足→打回L1 |
| 5 | L2 | **方案研究员** | `solution-researcher` | flash | 需求.md+架构方向 | **方案对比.md**：candidates[] + comparison + open_questions | schema无decision字段，不越权决策 |
| 🚪 | Gate2 | 人工 | — | — | 架构.md | 确认/打回（不可逆点） | — |
| 6 | L3a | **接口设计师** | `interface-designer` | flash+max | 架构.md | **contract.md**：接口签名+数据schema（锁定） | contract不满足需求→打回L2 |
| 7 | L3b | **前端开发** | `frontend-dev` | flash | contract.md | 代码 + deviationFromSpec字段 | 不擅自改contract |
| 8 | L3b | **后端开发** | `backend-dev` | flash | contract.md | 代码 + deviationFromSpec字段 | 同上 |
| 9 | L3c | **测试设计师** | `test-designer` | flash | **需求.md**（非代码） | **测试用例.md** | 禁止读实现代码 |
| 10 | L3c | **测试执行** | 无LLM（主代理跑） | — | 代码+用例 | 确定性 pass/fail + 日志 | 不判断 |
| 11 | L3d | **抽审**（tier=premium 触发） | `auditor` | pro | 代码+需求.md | 一致性报告 | 不让写的人自证 |
| 全程 | — | **主代理/指挥官** | — | flash | 各层交接物 | 派发决策+工单裁剪+汇报拦截 | 只做流程/格式判断 |

---

## 2. 模型/参数配置表

> **DeepSeek 官方规则（api-docs.deepseek.com/guides/thinking_mode）**：思考模式开启时 `temperature`/`top_p` 全部不生效。控制参数是 `thinking` 开关 + `reasoning_effort`（low/high/max）。
> **官方基准（DeepSeek-V4-Flash-0731 README）**：`Flash-Max achieves comparable reasoning performance to the Pro version`——Flash 开 max 思考 ≈ Pro，但便宜 3-6 倍。**pro 只留给最复杂的决策**。
> 思考模式三档（官方）：Non-think=快/直觉/日常；Think High=有意识分析/复杂求解/规划；Think Max=探索推理能力边界（token 消耗最大）。

| 角色 | 模型 | thinking | temp/top_p | 理由 |
|---|---|---|---|---|
| Router | flash（3票） | off | 0.0 / 1.0 | 纯分类，3票取多数，greedy（API 调用直接设，非子代理） |
| 需求分析师 | flash | max | （思考模式无效，不设） | Flash-Max 推理 ≈ Pro；L1 推理活，开 max 保准 |
| 检索员 | flash | off | 0.2 / 0.9 | 取数+结构化摘要，关思考省成本，temp 防幻觉 |
| 架构师 | **pro** | max | （无效，不设） | 最复杂决策，Pro 最后防线；人类Gate2拍板 |
| 方案研究员 | flash | off | 0.2 / 0.9 | 查资料填对比表，关思考省成本 |
| 接口设计师 | flash | max | （无效，不设） | 转换型+Flash-Max 够用，省 3 倍钱 |
| 前端/后端 | flash | off | 0.2 / 0.9 | 照contract抄；关思考快+便宜，temp 0.2 防幻觉 |
| 测试设计师 | flash | off | 0.3 / 0.9 | 用例生成需多样性（temp 0.3），关思考 |
| 测试执行 | — | — | — | 纯函数，无LLM |
| 抽审 | **pro** | max | （无效，不设） | 长程一致性核对，复杂推理，Pro |
| 主代理 | flash | off | 0.2 / 0.9 | 只做流程/格式判断，关思考省成本 |

模型分配规律：**pro 只有 4 个**（需求/架构/接口/抽审）——全是不可逆决策点或长程理解；**flash 有 6 个**——全是取数/照抄/填空。

---

## 3. 开发流程（SOP 流水线）

```
用户输入
   │
   ▼
① Router（flash×3）→ trivial? → 主代理直接做，不进流水线
                 → L1-L3? → 进流水线
   │
   ▼
② 并行：检索员（取数+填缺口） ⇄ 需求分析师（组织+写需求.md）   ← R1：最多2轮
   需求.md 完成（数据缺口清单必须填满或标unfilled+检索词）
   │
🚪 Gate1 人工：确认 / 打回
   │
   ▼
③ 并行：方案研究员（查prior art+填对比表） → 架构师（选型选项+架构.md）   ← R1：最多2轮
   架构.md 完成（每模块tier标注）
   │
🚪 Gate2 人工：确认 / 打回（不可逆技术决策点）
   │
   ▼
④ 接口设计师 → contract.md（锁定接口签名+schema）
   │
   ▼
⑤ 并行：前端开发（flash） + 后端开发（flash）——照contract填
   各自产出代码+deviationFromSpec   ← R2：deviation非空→接口设计师复核
   │
   ▼
⑥ 测试设计师（读需求.md反推用例，禁读代码）
   → 测试执行（纯函数跑）→ 确定性pass/fail   ← R3：失败先本人重试，超限升抽审
   │
   ▼
⑦ 抽审（tier=premium 自动触发）→ 一致性报告   ← R4：无额外人工判断
   │
   ▼
⑧ 主代理汇总 → 交付
```

---

## 4. 路由规则（硬约束，实现时必须写死）

### R1 · 迭代上限（防无限循环）
- ②需求⇄检索、③架构⇄研究员：**每层最多 2 轮**。
- 第 2 轮后仍有 gap → 直接标 `unfilled` + 已尝试检索词，进 Gate，**不再循环**。
- 实现：与 maxRetries 同机制——`iterationCount` 字段，`>=2` 强制停止。

### R2 · deviationFromSpec 路由
- 前后端产出中 `deviationFromSpec` 非空 → **自动路由给接口设计师复核**（不是主代理、不是架构师）。
- 接口设计师判断：偏差可接受 → 记录进 contract 修订；偏差破坏需求 → 升级到 Gate2。
- 主代理**不做内容判断**，只执行路由。

### R3 · 测试失败路由
- 测试失败 → **先回前后端本人重试**（≤maxRetries，默认 2）。
- 超限仍失败 → **升级抽审**（一致性报告），由抽审决定打回架构师重设计还是记录已知问题。
- 测试执行本身不判断，只输出确定性 pass/fail + 日志。

### R4 · 抽审触发（无模糊"低频"）
- **`tier=premium` 的模块自动触发抽审**，绑定架构.md 的 tier 标注，无需额外人工判断"算不算高风险"。
- 非 premium 模块默认不抽审（除非人工主动要求）。

---

## 5. 交接物 schema（每层输出必须严格按此填空，禁止自由发挥）

### 5.1 需求.md（需求分析师 → 架构师/测试设计师）
```markdown
# 需求
- taskId / 版本 / 来源（Router标签）
## 用户故事
（≤5条，每条一句话，flash可填）
## 验收标准
- AC1: ...（可测试，机械可校验）
## 边界
- in: ... / out: ...
## 非目标
- ...
## 数据缺口清单（强制，不允许空）
- GAP1: 需要什么数据 | 用途 | 状态: filled/unfilled | 检索词(≥3) | 原因
## 禁止
- 禁止编造数据；缺口必填，无"无"以外的沉默跳过
```

### 5.2 检索报告.md（检索员 → 需求分析师）
```markdown
# 检索报告
- taskId / 关联需求.md版本 / 检索时间
## findings（数组）
- finding_id: R01 | finding(≤50字) | evidence(≤200字) | source(必填) | confidence: high/medium/low | relevance(需求.md编号)
## gap_status（对需求.md数据缺口的逐条回应，强制）
- gap_id | status: filled/unfilled | filled→finding_id | unfilled→检索词(≥3)+原因
## 禁止
- 禁止粘贴原始网页/长文档（>200字必须摘要）
- 禁止无来源结论（无来源→confidence=low或进gap_status.unfilled）
```

### 5.3 架构.md（架构师 → 接口设计师/测试设计师）
```markdown
# 架构
- taskId / 关联需求.md版本
## 技术选型（选项+取舍，不是结论）
- 方案A/B/C | 各 pros/cons | 取舍理由 | 来源（引用方案对比.md）
## 模块划分
- M1: 职责 | 依赖 | tier: fast/standard/premium   ← tier 用于 R4 抽审触发
## 接口 contract 草案（交接给接口设计师）
- 模块间依赖契约要点
## 禁止
- 禁止直接拍板（选型结论由人类 Gate2 定）
- 数据不足 → 打回 L1，不猜
```

### 5.4 方案对比.md（方案研究员 → 架构师）
```markdown
# 方案对比
- taskId / 关联需求.md版本 / 关联架构方向
## candidates（数组）
- option_id: S01 | option_name | summary(≤50字) | pros(3-5条,≤30字) | cons(3-5条,≤30字) | adoption_evidence(必填来源) | risk: 高/中/低+一句话 | tier_hint: fast/standard/premium
## comparison（强制，固定维度表）
- 维度: 成本/生态成熟度/学习曲线/与现有代码兼容性/长期维护
- 每维度: 各方案评级(高/中/低) + 一句话依据
## open_questions（强制）
- 需要额外调研才能定论的方案点 → 必须列出
## 决策边界
- 本报告只提供选项和证据
- 【schema 中不存在 decision 字段】← 取舍决策权在架构师 Gate2 / 人类
```

### 5.5 contract.md（接口设计师 → 前后端）
```markdown
# 接口契约（锁定，前后端唯一依据）
- taskId / 版本
## 接口签名
- endpoint/方法 | 入参schema | 出参schema | 错误码
## 数据模型
- 表/对象结构（字段名+类型+必填）
## 修订记录
- v1.0 初始 | deviation 记录（R2 路由后追加）
## 禁止
- contract 无法满足需求 → 打回 L2，不自己改
```

### 5.6 测试用例.md（测试设计师 → 测试执行）
```markdown
# 测试用例
- taskId / 依据: 需求.md版本 + contract.md版本
## 用例（数组）
- TC1 | 前置 | 步骤 | 预期（可机械断言）| 对应验收标准 AC#
## 禁止
- 禁止读实现代码（依据必须是需求.md/contract.md）
- 禁止"对着答案出题"
```

---

## 6. 主代理执行清单（每轮行为）

1. 回顾自己的对话上下文 → 判断当前在 SOP 哪一层、已产出哪些交接物、下一步该派谁。
2. 用 Agent 工具派发对应角色（`run_in_background=true`）：`Agent(subagent_type, prompt, run_in_background=true)`。subagent_type 见第 1 节角色表。
3. 后台子代理完成 → pi 自动发 `<task-notification>`（含 task-id/status/result 预览）到你的上下文；需要完整结果用 `get_subagent_result`。
4. 收到交接物 → 按 SOP.md 第 5 节 schema 机械校验（字段齐全/来源存在/无空缺口）→ 不通过打回该层重做，通过进下一层。
5. 遇到 Gate（Gate1 需求确认 / Gate2 架构确认）→ 停下展示给用户，等回复后再继续，禁止自行替用户决策。
6. 并行角色（需求分析师⇄检索员、前端⇄后端）→ 同一轮发多个 Agent 调用，pi 会自动并行。
7. 任务完成 / 用户终止 → 在对话中清空自己的"进行中"认知，不残留。
8. 规模异常（架构师拆出任务数远超 Router 预估）→ 停下向用户展示，问是否降级/分批。

**主代理只做流程/格式判断，不做内容判断。内容判断权在：确定性规则（R1-R4）+ 人工 Gate + schema 结构排除。**

> 注意：状态机不落盘。主代理的"当前在哪一层"完全来自对话上下文记忆。pi 会话意外中断 → 靠 pi 自身 session 恢复（`pi --session`）续上。
