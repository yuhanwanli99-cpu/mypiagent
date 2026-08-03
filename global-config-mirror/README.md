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
`~\.pi\agent\agents\{software-architect,developer,tester,tester-visual}.md`，
这里不重复保存旧版本，避免和 AGENTS.md 里记录的最新版本产生混淆。

## v6 全局化补充（2026-08-03）

本机（`C:\Users\Administrator`）已把 SPOQ 从"单一项目目录"升级为"全局部署"，详见
`AGENTS.md` 的 "v6 全局化部署" 一节。与本目录相关的变化：

- `extensions/` 里新增的 `spoq-enforcer.ts` **不在这里重复保存**——它现在和
  agents/*.md 一样是"真正生效"的全局文件（`~\.pi\agent\extensions\spoq-enforcer.ts`），
  唯一权威源码仍是本仓库 `.pi/extensions/spoq-enforcer.ts`，只是新增了部署目标而已。
- 新增 `spoq-templates/`（本目录下）—— `~\.pi\agent\spoq-templates\` 的快照备份，
  内含 `agent-loops/*.md` 角色手册和 `spoq-state.schema.md`，供任意项目在缺少本地
  `.pi/agent-loops/{role}.md` 时兜底读取，是新项目"零配置接入 SPOQ"的关键。
