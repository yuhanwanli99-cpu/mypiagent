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
