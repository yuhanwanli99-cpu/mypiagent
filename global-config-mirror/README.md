# global-config-mirror

这个目录不是 SPOQ 项目本身运行时读取的配置（项目配置在 `.pi/`）。

它是从另一台/同一台机器（DESKTOP-KUHOI18）上曾经独立维护的 `~/.pi/agent`
全局配置仓库（同样指向 `mypiagent` 这个远端）里，挑出来的**非重复、有价值**的
扩展/技能/参考文件，纯粹作为版本控制备份保留在这里，避免历史内容丢失：

- `extensions/` — glm-compat、orca-*、pi-telemetry、zhipu-provider、
  pi-code-planner 指令集、pi-tool-display 配置。这些不是 SPOQ 流水线的一部分，
  是全局 `~/.pi/agent` 环境里安装的其他扩展。
- `models-store.json` — 全局模型清单快照（含 glm-4.1v 系列条目），仅供参考。
- `mcp.json` — 全局 MCP server 配置快照。
- `LICENSE` — 该仓库此前声明的公共领域许可。

**注意**：那个独立的全局配置 git 仓库（`C:\Users\33784\.pi\agent\.git`）已经
被摘除了 `origin` remote，不会再自动/手动 push 到这里，避免和本仓库
（`F:\piagent` 项目结构，`.pi/` 前缀）的目录约定继续冲突。以后如果需要更新
全局配置的备份，直接把新文件复制进这个目录、走 `F:\piagent` 一个仓库提交即可，
不要再从 `~/.pi/agent` 单独 git push。

真正生效的四个 SPOQ 角色定义（含模型锁定 / disallowed_tools）仍然在
`C:\Users\33784\.pi\agent\agents\{software-architect,developer,tester,tester-visual}.md`，
这里不重复保存旧版本，避免和 AGENTS.md 里记录的最新版本产生混淆。
