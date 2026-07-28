# Pi 迁移安全清单

> 在新电脑上完成 `pi-migration-guide.md` 的配置文件创建后，**逐项核查**本清单。
> 所有 `[ ]` 项都必须变为 `[x]` 才能正式使用 SPOQ 流水线。

---

## 🔴 阻断级（必须通过，否则禁止运行）

### API Key 安全

- [ ] **无硬编码 Key**：运行 `grep -rE '[a-f0-9]{32}\.[A-Za-z0-9]{8,}' ~/.pi/agent/` 必须无输出
- [ ] **models.json 不包含明文 Key**：apiKey 字段只能来自环境变量或运行时注入
- [ ] **旧扩展已清理**：`~/.pi/agent/extensions/zhipu-provider.ts` 不存在或已改用 `process.env`
- [ ] **文件权限**：`models.json` 权限应为 600（`ls -la ~/.pi/agent/models.json` 确认）

### 状态文件原子性

- [ ] **原子写入脚本可用**：`.pi/scripts/atomic-write.sh` 可执行（`chmod +x`）
- [ ] **enforcer 扩展已安装**：`pi --help` 确认 pi-committer 包在 packages 列表中
- [ ] **手动写测试**：用 `echo '{"test":1}' | bash .pi/scripts/atomic-write.sh /tmp/test.json` 验证 → `cat /tmp/test.json` 输出 `{"test":1}`

### pi-hermes-memory 健康

- [ ] **故障文件已清理**：`ls ~/.pi/agent/pi-hermes-memory/.failures.md.recovery-* | wc -l` 输出 0（或 < 5）
- [ ] **目录重建**：如果从旧机器拷贝了 pi-hermes-memory，已 `rm -rf ~/.pi/agent/pi-hermes-memory` 让其重建

---

## 🟡 重要（迁移后首次运行前检查）

### 配置完整性

- [ ] **settings.json 有效 JSON**：`python -m json.tool ~/.pi/agent/settings.json > /dev/null`
- [ ] **models.json 有效 JSON**：`python -m json.tool ~/.pi/agent/models.json > /dev/null`
- [ ] **3 个 Agent 都存在**：developer, software-architect, tester 的 `.md` 文件都在 `~/.pi/agent/agents/`
- [ ] **4 个 Agent Loop 都存在**：orchestrator, architect, developer, tester 在 `~/.pi/agent/agent-loops/`
- [ ] **Pi 可启动**：`pi --version` 成功，`pi --help` 显示所有命令

### Mailbox 安全

- [ ] **mailbox 目录存在**：`.pi/spoq-mailbox/` 目录已创建
- [ ] **mailbox 并发写安全**：理解了 timestamp 命名规则，确认不会出现同时写同一文件名

### Token Budget 合理性

- [ ] **Orchestrator tokenBudget**：确认 500000 在你的模型限制内（DeepSeek v4 最大输出 32K，500K 是上下文预算）
- [ ] **子代理 tokenBudget**：Architect 80000 / Developer 250000 / Tester 120000 在你的模型限制内

---

## 🟢 建议（运行后监控）

### 首次 SPOQ 运行后

- [ ] **spoq-state.json 无损坏**：`python -m json.tool .pi/spoq-state.json > /dev/null` 运行后仍然有效
- [ ] **lessons-learned.md 被写入**：运行一个 Wave 后检查文件是否有新条目
- [ ] **mailbox 通信正常**：`.pi/spoq-mailbox/` 下有正确命名的邮件文件
- [ ] **low_quality_pass 未滥用**：运行 3 个 Wave 后检查 spoq-state.json 的 `lowQualityPass` 字段 ≤ 1

### 持续监控

- [ ] **pi-hermes-memory 恢复文件数**：每周检查一次，超过 10 个 → 立即报告
- [ ] **Session 完整性**：`.meta.json` 和 `.jsonl` 成对出现
- [ ] **API Key 轮换**：每 90 天更换一次 Key 并重新运行 `setup-api-keys.sh`

---

## 📋 快速自检命令

```bash
# 一键运行所有检查
bash .pi/scripts/pi-validate.sh

# 单独检查 API Key 泄露
grep -rE '[a-f0-9]{32}\.[A-Za-z0-9]{8,}' ~/.pi/agent/ 2>/dev/null && echo "❌ KEY LEAK" || echo "✅ Clean"

# 检查 JSON 有效性
for f in ~/.pi/agent/*.json ~/.pi/agent/**/*.json; do
  python3 -m json.tool "$f" > /dev/null 2>&1 || echo "❌ $f"
done && echo "✅ All JSON valid"

# 检查 pi-hermes-memory 故障文件
find ~/.pi/agent/pi-hermes-memory -name ".failures.md.recovery-*" 2>/dev/null | wc -l
```

---

## 🚨 紧急情况处理

| 症状 | 处理 |
| --- | --- |
| `spoq-state.json` JSON 损坏 | `cp .pi/spoq-state.json.backup.* .pi/spoq-state.json`（取最新备份） |
| pi-hermes-memory 死循环 | `rm -rf ~/.pi/agent/pi-hermes-memory/` → 重启 Pi |
| 子代理一直 retry | 检查 `spoq-state.json` → 手动改 `state: "blocked"` → 重启 |
| API Key 泄露到 Git | 立即轮换 Key + `git filter-branch` 清除历史 |

---

> **签名**：_____________ &nbsp;&nbsp;&nbsp; **日期**：_____________
>
> 迁移完成前，逐项打勾。全部 `🔴` 和 `🟡` 项通过后方可启用 SPOQ 自动化流水线。
