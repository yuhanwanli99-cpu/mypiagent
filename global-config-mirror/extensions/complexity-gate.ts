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
          `输出: <!-- SPOQ-ROUTE: SIMPLE|COMPLEX|LARGE -->\n` +
          `<!-- EST_TASKS: 数字 --><!-- EST_FILES: 数字 --><!-- REASON: 一句话 -->\n` +
          `SIMPLE: 单文件单模块无新依赖，改动 < 5 处（主代理直接干，不进流水线）\n` +
          `COMPLEX: 多模块但范围清晰（主代理生成计划 → 并行派多个 coder 实现）\n` +
          `LARGE: 深度重构/跨平台/长程依赖/接口联动（走完整 SOP 状态机）\n` +
          `LARGE 的判断标准：需要先摸清现状再定方案（重构/新架构/多端联动）才算；否则是 COMPLEX。\n` +
          `不确定时倾向 COMPLEX。EST_TASKS 给出预估拆解出的任务数。EST_FILES 给出预估波及的文件数（先想：要改哪些文件、新建哪些、连带影响的哪些）。`
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

async function routeTask(cwd: string, text: string): Promise<{ mode: string; estTasks: number; estFiles: number; reason: string }> {
  const apiKey = getApiKey();
  if (!apiKey) return { mode: "LARGE", estTasks: 0, estFiles: 0, reason: "no_api_key（fail-closed：key 缺失时保守走 LARGE，阶段0 任务分解会触发人工确认）" };

  const repoCtx = collectRepoContext(cwd);
  // 自洽投票 3 次
  const results = await Promise.all([
    callRouter(apiKey, text, repoCtx),
    callRouter(apiKey, text, repoCtx),
    callRouter(apiKey, text, repoCtx),
  ]);
  const votes = results.map(r => {
    const m = r?.match(/<!--\s*SPOQ-ROUTE:\s*(SIMPLE|COMPLEX|LARGE)\s*-->/i);
    return m ? m[1].toUpperCase() : null;
  });
  const count = (label: string) => votes.filter(v => v === label).length;
  // 三档投票：LARGE 优先（保守，重构类宁可走完整流程），其次 SIMPLE，默认 COMPLEX
  const mode = count("LARGE") >= 2 ? "LARGE"
    : count("SIMPLE") >= 2 ? "SIMPLE"
    : "COMPLEX";
  const estMatch = results.find(r => r?.includes("EST_TASKS:"))?.match(/EST_TASKS:\s*(\d+)/i);
  const estTasks = estMatch ? parseInt(estMatch[1], 10) : 0;
  const fileMatch = results.find(r => r?.includes("EST_FILES:"))?.match(/EST_FILES:\s*(\d+)/i);
  const estFiles = fileMatch ? parseInt(fileMatch[1], 10) : 0;
  const reason = results.find(r => r?.includes("REASON:"))?.match(/REASON:\s*(.+?)\s*-->/i)?.[1] || "";

  appendAudit(cwd, { time: new Date().toISOString(), action: "routed", mode, votes, estTasks, estFiles, reason });
  return { mode, estTasks, estFiles, reason };
}

// ═══════════════════════════════════════
// 导出
// ═══════════════════════════════════════

export default function (pi: any) {

  // ── 会话内已确认机制（内存变量，不落盘）──
  // 每次 pi 进程启动 = 新会话 = 自动重置。第一次任务确认后记住；
  // 后续任务 Router 评估若与已确认机制不同（变档）→ 才二次确认；同档不弹。
  let sessionMode: string | null = null;

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
    const { mode, estTasks, estFiles, reason } = await routeTask(cwd, text);

    // ── 人工确认（UI 弹框，不是文本——文本会被主代理跳过）──
    // 前提：AI 自认为这次任务与【会话内已确认机制】不同（变档）时才弹。
    //  - 第一次任务：必弹（确立机制）
    //  - 后续任务：Router 评估出的档位与 sessionMode 相同 → 不弹直接干；不同 → 弹框二次确认
    //  - 少（SIMPLE 档）或多（LARGE 档）都是"与已确认机制不同"的情况，都会弹。
    const needsConfirm = sessionMode === null || sessionMode !== mode;
    let finalMode = mode;
    if (needsConfirm) {
      const modeLabels: Record<string, string> = {
        SIMPLE: "直接干（SIMPLE）——单文件小改动，主代理直接实现",
        COMPLEX: "计划+并行 coder（COMPLEX）——摸清现状→并行派多个 developer",
        LARGE: "完整 SOP（LARGE）——分解→契约→测试经理排班→并行TDD→收口",
      };
      const choices = [
        modeLabels[mode],
        ...Object.entries(modeLabels).filter(([k]) => k !== mode).map(([, v]) => v),
      ];
      const prompt = sessionMode === null
        ? `SPOQ: 预估波及 ${estFiles || "?"} 文件 / ${estTasks || "?"} 任务，Router 判为 ${mode}${reason ? `（${reason}）` : ""}。确认执行模式？`
        : `SPOQ: 本次任务 Router 评估为 ${mode}（预估 ${estFiles || "?"} 文件），与本会话已确认的 ${sessionMode} 模式不同。切换确认？`;
      const picked = await ctx.ui.select(prompt, choices);
      // 用户取消/超时 → fail-closed：默认走最保守的 LARGE（阶段0 分解会再确认）
      finalMode = picked
        ? (Object.entries(modeLabels).find(([, v]) => v === picked)?.[0] ?? "LARGE")
        : "LARGE";
      sessionMode = finalMode;
    }

    if (finalMode === "SIMPLE") {
      return { action: "transform", text: `[SPOQ] ROUTE=SIMPLE：单文件小改动，直接实现，不进流水线。项目目录: ${cwd}。\n\n${text}` };
    }
    if (finalMode === "COMPLEX") {
      return { action: "transform", text: `[SPOQ] ROUTE=COMPLEX（预估 ${estTasks} 任务${reason ? `，${reason}` : ""}）：多模块但范围清晰。项目目录: ${cwd}。主代理先摸清现状生成简短实现计划（分几个模块/几步），然后同一轮并行派多个 coder（developer）各自实现一块。不走完整 SOP（不需要需求分析师/架构师/抽审）。\n\n${text}` };
    }
    // LARGE：完整 SOP 状态机（五阶段）
    return { action: "transform", text: `[SPOQ] ROUTE=LARGE（预估 ${estTasks} 任务${reason ? `，${reason}` : ""}）：深度重构/跨平台/长程依赖，走完整 SOP 状态机。项目目录: ${cwd}（子代理工作目录同此，不要 cd 走）。先读 C:/Users/Administrator/.pi/agent/spoq-templates/SOP.md 了解角色流水线，然后按 LARGE 五阶段执行：⓪任务分解（侦察员并行分片→任务清单+依赖分组→人工确认）→ ①接口契约（需求设计师→contract-{module}.md）→ ②排班（测试经理按文件配对 tester+coder+文件锁）→ ③并行 TDD（tester 先写 RED→coder 实现 GREEN）→ ④收口（整体测试+错误分级）。\n\n${text}` };
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
        `\n- 首先看收到的 ROUTE 标签，按三种模式执行：` +
        `\n    ROUTE=SIMPLE → 直接实现，不派子代理。` +
        `\n    ROUTE=COMPLEX → 摸清现状 → 生成简短实现计划（分几个模块）→ 同一轮并行派多个 coder（developer）各自实现一块，不走完整 SOP。` +
        `\n    ROUTE=LARGE → 走完整 SOP 五阶段：⓪任务分解（侦察员并行→任务清单+依赖分组→人工确认）→ ①契约（需求设计师→contract-{module}.md）→ ②排班（测试经理按文件配对 tester+coder+文件锁）→ ③并行 TDD（tester 先写 RED→coder 实现 GREEN，失败经测试经理脱敏转发）→ ④收口（整体测试+错误分级：小错补丁/大错重写）。` +
        `\n- 每轮先回顾自己的对话上下文：当前进行到哪一步、已产出哪些交接物、下一步该派谁。` +
        `\n- 派发子代理用 Agent 工具（run_in_background=true），子代理是手脚，派发后不阻塞等待，继续推进或等其完成事件。` +
        `\n- 子代理的工作目录是 ${cwd}，prompt 里直接给绝对路径，不要让子代理自己找项目。` +
        `\n【探索后自检——二次确认的核心时机（强制）】` +
        `\n    任何模式（SIMPLE/COMPLEX/LARGE）在开始实现前都必须先摸清现状（SIMPLE 也至少看一眼目标文件/依赖是否存在），然后自问：` +
        `\n    "实际改动范围与 ROUTE 标签/已确认档位相符吗？"——具体检查：` +
        `\n    a) 目标功能/依赖是否已存在（例：任务说"实现 live2d 眨眼"但项目根本没有 live2d 组件）` +
        `\n    b) 实际要改的文件数、是否要新建模块/选架构/配测试，远超标签预估` +
        `\n    c) 是否需要跨端/跨语言（标签没提到但实际要碰）` +
        `\n    相符 → 继续按档位执行。不符（探索结果与初判断相反）→ 【停下，向用户展示探索发现 + 建议的新档位，让用户重新裁定】。` +
        `\n    禁止：探索后发现规模远超标签仍自行继续；禁止把"探索发现需求不存在"当小事跳过。` +
        `\n- LARGE 阶段0：派多个侦察员（flash，并行）按模块分片摸现状，各写 recon-{模块}.md，主代理汇合出任务分解清单+依赖分组，停下人工确认。` +
        `\n- LARGE 阶段2：测试经理排班（文件→tester+coder 配对，文件锁双向隔离：coder 禁读 tests/、tester 禁读 src/），依赖分组摘要上报你（紧凑版），文件评估留测试经理。` +
        `\n- LARGE 阶段3：tester 先写测试（RED）→ coder 实现（GREEN）；失败信息经测试经理脱敏转发（不报测试源码）；未完成依赖用契约测试/stub；同一行为点 ≥3 次 RED 不过上报你升级。` +
        `\n- LARGE 阶段4：整体测试失败 → 测试经理脱敏上报（含影响面）→ 你分级：小错（局部细节）直接指挥 coder 修；大错（结构性）回架构/环境分析→重排→TDD 重写。绝不在错架构上打补丁。` +
        `\n- 交接物固定写入 ${cwd}/.pi/spoq/（文件名见 SOP 5.0），路径在 prompt 里显式指定，子代理不得自创目录。` +
        `\n- 上下文瘦身：收到子代理完成通知后只记录指针（文件路径+一行摘要），绝不把交接物全文读进上下文。需要细节时再读文件。` +
        `\n- 遇到人工确认点（阶段0分解确认/阶段1契约确认/阶段4错误分级/探索后自检不符）→ 停下展示给用户，等回复后再继续。` +
        `\n- 子代理产出交接物必须符合 SOP.md 第 5 节 schema（字段齐全/来源存在），不合规打回该层重做。` +
        `\n- 你的记忆只来自当前对话上下文；任务完成或用户终止后，清空自己的"进行中"认知。` +
        `\n- 禁止：在用户没有回复菜单时自行替用户决策（Gate/模式选择必须等用户）。` +
        `\n- 禁止：自己深度探索项目源码——那是子代理的活，你只做派发和流程。` +
        `\n- 禁止：自己改生产代码行为逻辑（那是 coder 的活）——机械修复（import/依赖/格式）可做，行为修复必须派 coder 或标超范围。`,
    };
  });
}
