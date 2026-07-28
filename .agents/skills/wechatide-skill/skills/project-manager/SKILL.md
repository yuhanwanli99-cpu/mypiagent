---
name: project-manager
description: >-
  管理微信开发者工具已导入项目列表：查询、导入、从列表删除。不打开项目窗口。
  用户说项目列表、导入项目、从列表移除时使用。
---

# project-manager

## 用途

管理 WechatIDE「项目列表」，不替代 initializer 的开窗流程。未登录时先完成根入口检查。

从零创建项目目录并导入列表：见 [create-project-guide.md](../../wechatide-tools/references/create-project-guide.md)（配置走 `project-config`，导入用本 scene 的 `project_import`）。

## 流程

1. `project_list`（默认 `miniprogram`；可用 `--scope other|all`）
2. 纳入列表：`project_import --project <absPath>`
3. 移除列表：`project_remove --project <absPath>`（需用户确认；只删列表项，不删磁盘；窗口开着会一并关）
4. 要编译/调试 → `initializer` 的 `open_project_window`

```bash
wechatide -c <clientName> project_list
wechatide -c <clientName> project_import --project <absPath>
wechatide -c <clientName> project_remove --project <absPath>
```

| vs initializer | |
|----------------|--|
| `project_import` | 导入到项目列表（会校验路径/配置/appid；错误见 [project-tool-error-guide.md](../../wechatide-tools/references/project-tool-error-guide.md)） |
| `open_project_window` | 打开模拟器窗口 |
| `close_project_window` | 关窗，列表项仍在（不做上述校验） |

## 失败快表

| 情况 | 处理 |
|------|------|
| `PROJECT_*` / `APPID_ERROR`（import） | [project-tool-error-guide.md](../../wechatide-tools/references/project-tool-error-guide.md) |
| `project_remove` 待确认（`pending`）或用户拒绝 / 取消 | 勿自动再删；pending 按 [异步任务与轮询](../../references/async-task-polling.md)（根 SKILL「异步任务（全局）」） |
| 列表为空 | 说明未导入；创建流程走 create-project-guide |

## 移交

遵循根 SKILL「跨 scene 移交」。

| 目标 | 还需 |
|------|------|
| initializer | `project`；说明需开窗 |
| previewer | `project`；可不打开窗口 |
| create-project-guide | 用户要从零建目录时 |
| 结束 | 列表变更摘要（imported / removed） |
