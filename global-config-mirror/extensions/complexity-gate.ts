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

function callRouter(apiKey: string, taskText: string, repoCtx: string, askDecisions = false): Promise<string | null> {
  return new Promise((resolve) => {
    const decisionInstr = askDecisions
      ? `\n` +
        `\n**同时：识别这个需求里【需求→工程实现】的关键决策点**——即"用户没说但实现时必须选"的岔路：` +
        `\n- 技术栈/框架选择（如：web套壳 vs 原生 vs 跨端）` +
        `\n- 实现对象/模型选择（如：用哪个 live2d 模型/哪个 TTS）` +
        `\n- 行为/方案选择（如：播哪段动画/用什么交互方式）` +
        `\n对每个决策点输出（用非工程语言，普通人能懂）：` +
        `\n<!-- DECISION: 决策点一句话 -->` +
        `\n<!-- OPTION: 选项A | 一句话说明 | 优点 | 缺点 -->` +
        `\n<!-- OPTION: 选项B | 一句话说明 | 优点 | 缺点 -->` +
        `\n（无决策点则输出 <!-- DECISION: NONE -->）`
      : "";
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
          `不确定时倾向 COMPLEX。EST_TASKS 给出预估拆解出的任务数。EST_FILES 给出预估波及的文件数（先想：要改哪些文件、新建哪些、连带影响的哪些）。` +
          decisionInstr
      }],
      max_tokens: 600, temperature: 0.0,
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

async function routeTask(cwd: string, text: string, askDecisions = false): Promise<{ mode: string; estTasks: number; estFiles: number; reason: string; decisions: { question: string; options: { label: string; desc: string; pros: string; cons: string }[] }[] }> {
  const apiKey = getApiKey();
  if (!apiKey) return { mode: "LARGE", estTasks: 0, estFiles: 0, reason: "no_api_key（fail-closed：key 缺失时保守走 LARGE，阶段0 任务分解会触发人工确认）", decisions: [] };

  const repoCtx = collectRepoContext(cwd);
  // 自洽投票 3 次（决策点检测只需 1 次足够，复杂度仍投票）
  const results = await Promise.all([
    callRouter(apiKey, text, repoCtx, askDecisions),
    ...(askDecisions ? [] : [callRouter(apiKey, text, repoCtx), callRouter(apiKey, text, repoCtx)]),
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

  // 解析决策点（仅 askDecisions 时有）
  const decisions: { question: string; options: { label: string; desc: string; pros: string; cons: string }[] }[] = [];
  if (askDecisions) {
    const r = results[0] || "";
    const decBlocks = r.match(/<!-- DECISION: ([^\n]+) -->/g) || [];
    for (const block of decBlocks) {
      const qm = block.match(/DECISION: ([^\n]+)/);
      if (!qm || /NONE/i.test(qm[1])) continue;
      const q = qm[1].trim();
      const opts: { label: string; desc: string; pros: string; cons: string }[] = [];
      // 该决策点后的 OPTION 行（直到下一个 DECISION）
      const after = r.slice(r.indexOf(block) + block.length, r.indexOf(decBlocks[decBlocks.indexOf(block) + 1] ?? "\u0000"));
      for (const om of after.matchAll(/<!-- OPTION: ([^\n]+) -->/g)) {
        const parts = om[1].split("|").map(s => s.trim());
        opts.push({ label: parts[0] || "", desc: parts[1] || "", pros: parts[2] || "", cons: parts[3] || "" });
      }
      if (opts.length) decisions.push({ question: q, options: opts });
    }
  }

  appendAudit(cwd, { time: new Date().toISOString(), action: askDecisions ? "routed+decisions" : "routed", mode, votes, estTasks, estFiles, reason, decisions: decisions.length });
  return { mode, estTasks, estFiles, reason, decisions };
}

// ═══════════════════════════════════════
// 导出
// ═══════════════════════════════════════

export default function (pi: any) {

  // ── 会话内已确认机制（内存变量，不落盘）──
  // 每次 pi 进程启动 = 新会话 = 自动重置。
  // 注意：档位（SIMPLE/COMPLEX/LARGE）由 AI 自己判断，不需要用户选——
  // 用户唯一的确认点是：干活前"是否开干"（见 input 事件 + 注入纪律）。
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

    // ── 翻译层：决策点检测 + 用户取舍（在复杂度锁死前）──
    // 主模型 = 工程↔非工程翻译器：识别需求里"用户没说但实现时必须选"的岔路，
    // 翻译成非工程语言+选项+利弊，弹框让用户做平衡取舍（不靠 AI 想当然填技术栈）。
    const firstPass = await routeTask(cwd, text, true);
    let decisionText = "";
    if (firstPass.decisions.length > 0) {
      const picked: string[] = [];
      for (const d of firstPass.decisions) {
        const opts = d.options.map(o => `${o.label}（${o.desc}）\n    👍 ${o.pros}\n    👎 ${o.cons}`);
        const sel = await ctx.ui.select(
          `需求决策：${d.question}（由你取舍，AI 不替你选）`,
          opts,
        );
        if (sel) {
          const label = sel.split("（")[0].trim();
          picked.push(`${d.question} → 选 ${label}`);
        }
      }
      if (picked.length) {
        decisionText = "\n\n【用户已做的技术取舍】\n" + picked.map(p => `- ${p}`).join("\n");
        text = text + decisionText; // 用户决策并入任务描述
      }
    }

    // Router 分类（带用户决策后重新判定，不落任何状态）
    // 档位由 AI 自己判断（用户只输入意图，不需要选档位）
    const { mode, estTasks, estFiles, reason } = await routeTask(cwd, text);
    sessionMode = mode; // 记住 AI 判断的档位（仅用于参考/日志）

    // ── 不再弹档位选择框（用户不选档位，AI 自己定）──
    // 用户唯一的人工确认 = 干活前"是否开干"，由主代理在探索+微计划后停下问，
    // 确认词（确认/继续/ok/好等）直接放行回主代理上下文消费。

    if (mode === "SIMPLE") {
      return { action: "transform", text: `[SPOQ] ROUTE=SIMPLE（AI 自判：预估波及 ${estFiles || "?"} 文件${reason ? `，${reason}` : ""}）：单文件小改动。项目目录: ${cwd}。执行前先看一眼目标文件/依赖是否真的存在（探索后自检），然后向用户展示简短计划并问"是否开干"，用户确认后再动手；若探索发现规模远超预期（如项目根本没有目标功能），停下向用户说明并让其重新裁定。\n\n${text}` };
    }
    if (mode === "COMPLEX") {
      return { action: "transform", text: `[SPOQ] ROUTE=COMPLEX（AI 自判：预估 ${estTasks} 任务 / ${estFiles || "?"} 文件${reason ? `，${reason}` : ""}）：多模块但范围清晰。项目目录: ${cwd}。流程：①探索摸清现状（探索后自检：实际范围与预估相符？不符→停下让用户重新裁定）②生成简短实现计划（分几个模块/几步）③【停下向用户展示微计划并问"是否开干"】④用户确认后同一轮并行派多个 coder（developer）各自实现一块 ⑤汇总交付。不走完整 SOP（不需要需求分析师/架构师/抽审）。\n\n${text}` };
    }
    // LARGE：完整 SOP 状态机（五阶段）
    return { action: "transform", text: `[SPOQ] ROUTE=LARGE（AI 自判：预估 ${estTasks} 任务 / ${estFiles || "?"} 文件${reason ? `，${reason}` : ""}）：深度重构/跨平台/长程依赖，走完整 SOP 状态机。项目目录: ${cwd}（子代理工作目录同此，不要 cd 走）。先读 C:/Users/Administrator/.pi/agent/spoq-templates/SOP.md 了解角色流水线，然后按 LARGE 五阶段执行：⓪任务分解（侦察员并行分片→任务清单+依赖分组→人工确认）→ ①接口契约（需求设计师→contract-{module}.md）→ ②排班（测试经理按文件配对 tester+coder+文件锁）→ ③并行 TDD（tester 先写 RED→coder 实现 GREEN）→ ④收口（整体测试+错误分级）。其中"⓪任务分解后的人工确认"就是"是否开干"确认点。\n\n${text}` };
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
        `\n【你的角色：工程↔非工程翻译器】` +
        `\n    你是主模型：用户只输入意图（可能是非工程语言），你的职责是——` +
        `\n    ① 摸工程现状（可以指挥其他 AI 作为探索双手——可以不是必须；简单自己看，复杂派侦察员）` +
        `\n    ② 把需求翻译成工程决策点：识别"用户没说但实现时必须选"的岔路（技术栈/模型/方案选择）` +
        `\n    ③ 每个决策点用非工程语言给选项+利弊，让用户做平衡取舍（你只呈现，不替你选）` +
        `\n    ④ 用户取舍后需求和工程锁死 → 复杂度才可判 → 走 SIMPLE/COMPLEX/LARGE` +
        `\n    禁止：想当然填自己熟悉的技术栈（如 web 套壳）而不给用户选；禁止替用户做技术选型决策。` +
        `\n- 首先看收到的 ROUTE 标签，按三种模式执行：` +
        `\n    ROUTE=SIMPLE → 直接实现，不派子代理。` +
        `\n    ROUTE=COMPLEX → 摸清现状 → 架构师（或你自己）产出计划 → 用户确认 → 并行 TDD（多对 tester+coder，文件锁：coder 禁读 tests/、tester 禁读 src/）。` +
        `\n    ROUTE=LARGE → 走完整 SOP 五阶段：⓪任务分解（侦察员并行→任务清单+依赖分组→人工确认）→ ①契约（接口设计师+测试经理共同产出 contract-{module}.md）→ ②排班（测试经理按文件配对 tester+coder+文件锁）→ ③并行 TDD（tester 先写 RED→coder 实现 GREEN，失败经测试经理脱敏转发）→ ④收口（整体测试+错误分级：小错补丁/大错重写）。` +
        `\n- 每轮先回顾自己的对话上下文：当前进行到哪一步、已产出哪些交接物、下一步该派谁。` +
        `\n- 派发子代理用 Agent 工具（run_in_background=true），子代理是手脚，派发后不阻塞等待，继续推进或等其完成事件。` +
        `\n- 子代理的工作目录是 ${cwd}，prompt 里直接给绝对路径，不要让子代理自己找项目。` +
        `\n【探索后自检 + 是否开干确认（强制）】` +
        `\n    用户只输入意图，档位由你（Router 已判）决定。开工前必须：` +
        `\n    ① 探索/摸清现状（SIMPLE 也至少看一眼目标文件/依赖是否存在；复杂任务可派侦察员当你的手）` +
        `\n    ② 自问"实际改动范围与 ROUTE 档位相符吗？"——检查：目标功能/依赖是否已存在（例：任务说"实现 live2d 眨眼"但项目根本没有 live2d）、实际要改文件数/新建模块/选架构/配测试是否远超预估、是否要跨端` +
        `\n    ③ 相符 → 生成简短微计划 → 【停下，向用户展示确认信息并问"是否开干"】，用户确认后再动手` +
        `\n       确认信息必须包含三部分：` +
        `\n       (a) 复杂度判定：AI 判为 X 档（SIMPLE/COMPLEX/LARGE）+ 一句话理由` +
        `\n       (b) 改动预估：预估波及 N 文件 / M 任务（Router 的 EST_FILES/EST_TASKS）` +
        `\n       (c) 微计划：改哪些文件/新建什么/怎么验证（≤5 行）` +
        `\n    ④ 不符（探索结果与初判断相反）→ 【停下，向用户展示探索发现 + 建议的新档位，让用户重新裁定】` +
        `\n    禁止：探索后发现规模远超档位仍自行继续；禁止跳过"是否开干"直接动手；禁止确认时不展示复杂度判定/改动预估/微计划。` +
        `\n- LARGE 阶段0：派多个侦察员（flash，并行）按模块分片摸现状，各写 recon-{模块}.md，主代理汇合出任务分解清单+依赖分组，停下人工确认。` +
        `\n- LARGE 阶段1 契约：接口设计师（接口签名+schema）+ 测试经理（验收断言）共同产出 contract-{module}.md——契约 = 接口定义 + 可执行验收，不是单一"需求设计师"。` +
        `\n- LARGE 阶段2：测试经理排班（文件→tester+coder 配对，文件锁双向隔离：coder 禁读 tests/、tester 禁读 src/），依赖分组摘要上报你（紧凑版），文件评估留测试经理。` +
        `\n- LARGE 阶段3：tester 先写测试（RED）→ coder 实现（GREEN）；失败信息经测试经理脱敏转发（不报测试源码）；未完成依赖用契约测试/stub；同一行为点 ≥3 次 RED 不过上报你升级。` +
        `\n- LARGE 阶段4：整体测试失败 → 测试经理脱敏上报（含影响面）→ 你分级：小错（局部细节）直接指挥 coder 修；大错（结构性）回架构/环境分析→重排→TDD 重写。绝不在错架构上打补丁。` +
        `\n- 交接物固定写入 ${cwd}/.pi/spoq/（文件名见 SOP 5.0），路径在 prompt 里显式指定，子代理不得自创目录。` +
        `\n- 上下文瘦身：收到子代理完成通知后只记录指针（文件路径+一行摘要），绝不把交接物全文读进上下文。需要细节时再读文件。` +
        `\n- 遇到人工确认点（决策点取舍/阶段0分解确认/阶段1契约确认/阶段4错误分级/探索后自检不符/是否开干）→ 停下展示给用户，等回复后再继续。` +
        `\n- 子代理产出交接物必须符合 SOP.md 第 5 节 schema（字段齐全/来源存在），不合规打回该层重做。` +
        `\n- 你的记忆只来自当前对话上下文；任务完成或用户终止后，清空自己的"进行中"认知。` +
        `\n- 禁止：在用户没有回复菜单时自行替用户决策（Gate/模式选择/技术选型必须等用户）。` +
        `\n- 禁止：想当然填技术栈或假设需求细节（那是翻译层要问用户的）；禁止把模糊需求当已明确处理。` +
        `\n- 禁止：自己改生产代码行为逻辑（那是 coder 的活）——机械修复（import/依赖/格式）可做，行为修复必须派 coder 或标超范围。`,
    };
  });
}
