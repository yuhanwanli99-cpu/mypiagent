// complexity-gate.ts v5 — 极简：Router 分类 + SOP 剧本注入
// 铁律 4: 输入只有一个入口
// 铁律 6: 状态机只靠主代理自己的上下文记忆，不落盘任何状态文件。
//         本扩展只做两件事：
//         1) Router：判断任务走"直接干"还是"走 SOP 流水线"
//         2) 把 SOP.md 剧本注入主代理 system prompt（主代理靠记忆执行）
// 部署: ~/.pi/agent/extensions/complexity-gate.ts

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { request } from "node:https";
import { homedir } from "node:os";

// ═══════════════════════════════════════
// 轻量审计（可选，不落状态）
// ═══════════════════════════════════════

function appendAudit(cwd: string, entry: unknown): void {
  try {
    const { mkdirSync, appendFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    appendFileSync(join(cwd, ".pi", "spoq-audit.jsonl"), JSON.stringify(entry) + "\n");
  } catch {}
}

// ═══════════════════════════════════════
// Router（分类器，只输出路由信号，不落状态）
// ═══════════════════════════════════════

function spoqEnabled(cwd: string): boolean { return existsSync(join(cwd, ".pi")); }

function getApiKey(): string | null {
  try {
    const authFile = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");
    return JSON.parse(readFileSync(authFile, "utf8"))?.deepseek?.key || null;
  } catch { return null; }
}

function collectRepoContext(cwd: string): string {
  const parts: string[] = [];
  const files: string[] = [];
  function walk(dir: string, depth: number) {
    if (depth > 2 || files.length >= 50) return;
    try {
      for (const e of readdirSync(dir)) {
        if (e.startsWith(".") || e === "node_modules" || e === "build" || e === "cache") continue;
        const fp = join(dir, e);
        try { if (statSync(fp).isDirectory()) { walk(fp, depth + 1); } else { files.push(relative(cwd, fp)); } } catch {}
      }
    } catch {}
  }
  walk(cwd, 0);
  if (files.length) parts.push("文件列表(前40): " + files.slice(0, 40).join(", "));
  try {
    const log = execSync("git log --oneline -5", { cwd, timeout: 3000, stdio: ["pipe","pipe","ignore"] }).toString().trim();
    if (log) parts.push("最近提交: " + log);
  } catch {}
  return parts.join("\n");
}

function callRouter(apiKey: string, taskText: string, repoCtx: string): Promise<string | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{
        role: "user",
        content:
          `你是 Router。判断任务规模并给出执行模式。\n\n任务: "${taskText}"\n\n代码库:\n${repoCtx}\n\n` +
          `输出: <!-- SPOQ-ROUTE: DIRECT|PIPELINE|ESCALATE -->\n` +
          `<!-- EST_TASKS: 数字 -->\n<!-- REASON: 一句话 -->\n` +
          `DIRECT: 单文件单模块无新依赖（主代理直接干，不进流水线）\n` +
          `PIPELINE: 多文件/多模块/新依赖（走 SOP 全程）\n` +
          `ESCALATE: 预估任务数 > 10 或无法评估规模（上报用户选模式）\n` +
          `不确定时倾向 PIPELINE。EST_TASKS 给出预估拆解出的任务数。`
      }],
      max_tokens: 200, temperature: 0.0,
      extra_body: { thinking: { type: "disabled" } }
    });
    const req = request({
      hostname: "api.deepseek.com", path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "Content-Length": Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d).choices?.[0]?.message?.content || null); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function routeTask(cwd: string, text: string): Promise<{ mode: string; estTasks: number; reason: string }> {
  const apiKey = getApiKey();
  if (!apiKey) return { mode: "PIPELINE", estTasks: 0, reason: "no_api_key" };

  const repoCtx = collectRepoContext(cwd);
  // 自洽投票 3 次
  const results = await Promise.all([
    callRouter(apiKey, text, repoCtx),
    callRouter(apiKey, text, repoCtx),
    callRouter(apiKey, text, repoCtx),
  ]);
  const votes = results.map(r => {
    const m = r?.match(/<!--\s*SPOQ-ROUTE:\s*(DIRECT|PIPELINE|ESCALATE)\s*-->/i);
    return m ? m[1].toUpperCase() : null;
  });
  const count = (label: string) => votes.filter(v => v === label).length;
  const mode = count("ESCALATE") >= 2 ? "ESCALATE"
    : count("DIRECT") >= 2 ? "DIRECT"
    : "PIPELINE";
  const estMatch = results.find(r => r?.includes("EST_TASKS:"))?.match(/EST_TASKS:\s*(\d+)/i);
  const estTasks = estMatch ? parseInt(estMatch[1], 10) : 0;
  const reason = results.find(r => r?.includes("REASON:"))?.match(/REASON:\s*(.+?)\s*-->/i)?.[1] || "";

  appendAudit(cwd, { time: new Date().toISOString(), action: "routed", mode, votes, estTasks, reason });
  return { mode, estTasks, reason };
}

// ═══════════════════════════════════════
// 导出
// ═══════════════════════════════════════

export default function (pi: any) {

  // ── input: 统一入口——Router 分类，transform 给主代理明确信号 ──
  pi.on("input", async (event: any, ctx: any) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (!spoqEnabled(cwd)) return { action: "continue" };
    let text = (event.text ?? "").trim();
    if (!text) return { action: "continue" };

    // 剥离 /impl 前缀
    if (text.startsWith("/impl")) text = text.replace(/^\/impl\s*/, "").trim();
    if (!text) return { action: "continue" };

    // ── 菜单回复/确认词/单字母 → 直接放行，不跑 Router ──
    // 主代理在等 Gate/模式选择回复时，用户的 A/B/C 或确认词必须原样到达主代理上下文，
    // 由主代理自己消费（状态机靠主代理记忆）。绝不能把回复当新任务分类（否则死循环）。
    const confirmWords = ["确认", "继续", "直接做", "ok", "yes", "行", "好", "同意", "可以"];
    const singleLetter = /^[ABC][。.\s]*$/i.test(text);
    if (confirmWords.includes(text.toLowerCase().trim()) || singleLetter) {
      return { action: "continue" }; // 原样放行
    }

    // Router 分类（不落任何状态，只给主代理一个信号）
    const { mode, estTasks, reason } = await routeTask(cwd, text);

    if (mode === "DIRECT") {
      return { action: "transform", text: `[SPOQ] ROUTE=DIRECT：单文件小改动，直接实现。项目目录: ${cwd}。\n\n${text}` };
    }
    // PIPELINE / ESCALATE：统一按 SOP 执行。
    // 规模确认不在这里做——主代理读完 SOP 执行清单第 8 条会自己停下问用户（模式选择必须等用户），
    // 避免两层菜单混乱（Router 弹一次 + 主代理弹一次）。
    return { action: "transform", text: `[SPOQ] ROUTE=${mode}（预估 ${estTasks} 任务${reason ? `，${reason}` : ""}）：按 SOP.md 执行。项目目录: ${cwd}（子代理工作目录同此，不要 cd 走）。先读 C:/Users/Administrator/.pi/agent/spoq-templates/SOP.md 了解角色流水线，然后从 L1（需求分析师+检索员）开始派发子代理。若预估任务数远超 10 或规模异常，按 SOP 执行清单第 8 条停下向用户确认执行模式。\n\n${text}` };
  });

  // ── before_agent_start: 注入 SOP 剧本（主代理靠上下文记忆执行，不落盘）──
  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (!spoqEnabled(cwd)) return {};

    // 读 SOP 剧本注入（剧本本身是静态文件，不算状态机）
    let sopText = "";
    try { sopText = readFileSync(join(homedir(), ".pi", "agent", "spoq-templates", "SOP.md"), "utf-8"); } catch {}

    return {
      systemPrompt:
        `你是 SPOQ 集群的指挥官（主代理）。你不是自由探索的助手，而是按 SOP 剧本执行的角色流水线指挥者。` +
        `\n` +
        `\n=== 项目位置 ===` +
        `\n当前项目根目录: ${cwd}。子代理工作目录也是 ${cwd}。绝对不要 cd 到其他目录找项目——项目就在 CWD。` +
        `\n=== SOP 剧本 ===` +
        `\n${sopText || "（SOP.md 未找到，按常规方式处理）"}` +
        `\n=== 执行纪律 ===` +
        `\n- 每轮先回顾自己的对话上下文：当前进行到 SOP 的哪一层、已产出哪些交接物、下一步该派谁。` +
        `\n- 派发子代理用 Agent 工具（run_in_background=true），子代理是手脚，派发后不阻塞等待，继续推进或等其完成事件。` +
        `\n- 子代理的工作目录是 ${cwd}，prompt 里直接给绝对路径，不要让子代理自己找项目。` +
        `\n- 调研/查证阶段（L1/L2）：按缺口拆批派发。需求分析师/架构师产出缺口清单后，把 GAP1..N 分成几组，每组一个检索员（每个只填 1-3 个缺口），同一轮并行发。缺口未闭合就按剩余缺口重拆再派，禁止一个 agent 同时扛"合并+对账+构建核实"。` +
        `\n- 交接物固定写入 ${cwd}/.pi/spoq/（文件名见 SOP 5.0），路径在 prompt 里显式指定，子代理不得自创目录。多个检索员分片（search-report-{gapid}.md）由你机械汇合。` +
        `\n- 遇到 Gate1/Gate2 人工确认点 → 停下展示给用户，等回复后再继续。` +
        `\n- 子代理产出交接物必须符合 SOP.md 第 5 节 schema（字段齐全/来源存在），不合规打回该层重做。` +
        `\n- 你的记忆只来自当前对话上下文；任务完成或用户终止后，清空自己的"进行中"认知。` +
        `\n- 禁止：在用户没有回复菜单时自行替用户决策（Gate/模式选择必须等用户）。` +
        `\n- 禁止：自己深度探索项目源码——那是子代理（需求分析师/检索员）的活，你只做派发和流程。`,
    };
  });
}
