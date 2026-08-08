// spoq-enforcer.ts v5 — 极简：子代理成本记账
// 铁律 6: 状态机已废除，本扩展只做成本记账（独立功能，不依赖任何状态文件）。
// 门禁白名单 / spoq_tick 工具 / mailbox 完成检测 / subagents 事件接线 —— 全部删除。
// 部署: ~/.pi/agent/extensions/spoq-enforcer.ts

import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ═══════════════════════════════════════
// 价格记录
// ═══════════════════════════════════════

interface ModelPrice { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; }
const modelPrices = new Map<string, ModelPrice>();
function loadModelPrices() {
  try {
    const modelsJson = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models-store.json"), "utf-8"));
    for (const [provider, data] of Object.entries(modelsJson as Record<string, any>)) {
      for (const model of data?.models ?? []) {
        if (model.id && model.cost) modelPrices.set(`${provider}/${model.id}`, model.cost);
      }
    }
  } catch {}
}
loadModelPrices();

function appendCostLog(cwd: string, data: string) {
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    appendFileSync(join(cwd, ".pi", "spoq-cost.jsonl"), data, "utf-8");
  } catch {}
}

// ═══════════════════════════════════════
export default function (pi: any) {
// ═══════════════════════════════════════

  // ── after_agent_end: 成本记账（唯一的保留功能）──
  pi.on("after_agent_end", async (event: any, ctx: any) => {
    try {
      const cwd = ctx.cwd ?? process.cwd();
      const msgs = event.messages ?? [];
      for (const m of msgs) {
        if (m.role !== "assistant") continue;
        const u = m.usage; if (!u) continue;
        const modelId = m.responseModel || m.model || ctx?.model?.id || "unknown";
        const provider = m.provider || ctx?.model?.provider || "unknown";
        const price = modelPrices.get(`${provider}/${modelId}`);
        const cost = price ? {
          input: (u.inputTokens ?? 0) / 1_000_000 * (price.input ?? 0),
          output: (u.outputTokens ?? 0) / 1_000_000 * (price.output ?? 0),
          cacheRead: (u.cacheReadTokens ?? 0) / 1_000_000 * (price.cacheRead ?? 0),
          cacheWrite: (u.cacheWriteTokens ?? 0) / 1_000_000 * (price.cacheWrite ?? 0),
          total: 0,
        } : null;
        if (cost) cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
        appendCostLog(cwd, JSON.stringify({
          ts: new Date().toISOString(), model: modelId, provider, ...u, ...(cost ?? {}), currency: "USD",
        }) + "\n");
      }
    } catch {}
  });
}
