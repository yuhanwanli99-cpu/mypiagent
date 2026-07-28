# SPOQ 邮箱系统

子代理间的直接通信通道。Orchestrator 不中转消息——代理自己读写。

## 目录结构

```
.pi/spoq-mailbox/
  {task-id}/
    architect→developer-{ISO时间戳}.md
    developer→architect-{ISO时间戳}.md
    tester→developer-{ISO时间戳}.md
    developer→tester-{ISO时间戳}.md
    any→orchestrator-{ISO时间戳}.md
```

## 文件命名规则

**所有邮件使用时间戳命名避免并发覆写：`{from}→{to}-{ISO8601-timestamp}.md`**

示例：`architect→developer-2026-07-16T14:30:00Z.md`

## 使用方式

每个子代理在被派发时会被告知：

- 自己的角色（architect/developer/tester）
- 任务 ID
- 邮箱路径

### 写入消息

创建新文件（时间戳保证不覆写）：

```markdown
## {timestamp} — {from}

{message body}
```

### 读取消息

子代理在开始工作前：

1. **列出目录文件**（使用 `ls` 工具）
2. **过滤**目标发件人的邮件：`{from}→{myrole}-*.md`
3. **按文件名时间戳排序**，读取最新的那条

### 关键场景

| 场景 | 发件人 | 收件人 | 文件（示例） |
| ------ | ------- | -------- | ------------- |
| 设计歧义需要澄清 | developer | architect | `developer→architect-2026-07-16T14:30:00Z.md` |
| 架构师补充说明 | architect | developer | `architect→developer-2026-07-16T14:30:00Z.md` |
| 测试发现设计偏离 | tester | developer | `tester→developer-2026-07-16T14:45:00Z.md` |
| 测试发现设计问题 | tester | architect | `tester→architect-2026-07-16T14:45:00Z.md` |
| 任何代理需要 Orchestrator 介入 | any | orchestrator | `any→orchestrator-2026-07-16T14:50:00Z.md` |

## Orchestrator 的职责

Orchestrator 在每次轮询时：

1. 列出 `.pi/spoq-mailbox/{task-id}/` 下所有 `any→orchestrator-*.md`，按时间戳排序取最新
2. 如有需要介入的消息，更新状态或转发
3. 不修改其他邮箱文件

## 并发安全

`any→orchestrator-*.md` 可被多个代理同时写入。时间戳命名确保每次写入都是独立文件，不会发生覆写竞态条件。
