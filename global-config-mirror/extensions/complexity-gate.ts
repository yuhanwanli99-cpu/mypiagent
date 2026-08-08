// complexity-gate.ts v7 — 翻译器扩展（路由已彻底废除）
// 废除原因（实测）：flash×3 复杂度预分类灾难性误判（纯调研任务判成"跨平台深度重构"），
// 且每次提交被拦截注入 ROUTE 标签卡流程；确认词/单字母放行是路由的残留功能（防死循环用），一并废除。
// 复杂度判断交给主代理探索后自己做（探索后的实际判断，不是预猜）。
//
// 本扩展只做两件事：
// 1) 决策点翻译层（可选）：用户输入意图后，检测【需求→工程】决策点（技术栈/模型/方案岔路），
//    翻译成非工程语言+选项+利弊 → ctx.ui.select 弹框让用户取舍 → 选择并入任务描述。
//    这是"用户补充 + 工程约束锁死复杂度"的机制，不判档位。
// 2) 把 SOP.md 剧本注入主代理 system prompt（主代理自己探索、自己判断复杂度、问"是否开干"）
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
// 翻译层：决策点检测（只问用户，不判档位）
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

interface Decision { question: string; options: { label: string; desc: string; pros: string; cons: string }[] }

function callDecisionDetector(apiKey: string, taskText: string, repoCtx: string): Promise<string | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{
        role: "user",
        content:
          `你是需求翻译器。用户只输入意图（可能是非工程语言）。识别这个需求里【需求→工程实现】的关键决策点——\n` +
          `即"用户没说但实现时必须选"的岔路：\n` +
          `- 技术栈/框架选择（如：web套壳 vs 原生 vs 跨端）\n` +
          `- 实现对象/模型选择（如：用哪个 live2d 模型/哪个 TTS）\n` +
          `- 行为/方案选择（如：播哪段动画/用什么交互方式）\n` +
          `- 边界/约束（如：性能要求/兼容范围/预算）\n` +
          `任务: "${taskText}"\n\n代码库:\n${repoCtx}\n\n` +
          `对每个决策点输出（用非工程语言，普通人能懂）：\n` +
          `<!-- DECISION: 决策点一句话 -->\n` +
          `<!-- OPTION: 选项A | 一句话说明 | 优点 | 缺点 -->\n` +
          `<!-- OPTION: 选项B | 一句话说明 | 优点 | 缺点 -->\n` +
          `（无决策点则输出 <!-- DECISION: NONE -->）\n` +
          `禁止编造选项；选项必须来自真实工程选择；不确定的工程现实标注"需探索确认"。`
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

async function detectDecisions(cwd: string, text: string): Promise<Decision[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];
  const repoCtx = collectRepoContext(cwd);
  const r = await callDecisionDetector(apiKey, text, repoCtx);
  if (!r) return [];
  const decisions: Decision[] = [];
  const decBlocks = r.match(/<!-- DECISION: ([^\n]+) -->/g) || [];
  for (const block of decBlocks) {
    const qm = block.match(/DECISION: ([^\n]+)/);
    if (!qm || /NONE/i.test(qm[1])) continue;
    const q = qm[1].trim();
    const opts: { label: string; desc: string; pros: string; cons: string }[] = [];
    const after = r.slice(r.indexOf(block) + block.length, r.indexOf(decBlocks[decBlocks.indexOf(block) + 1] ?? "\u0000"));
    for (const om of after.matchAll(/<!-- OPTION: ([^\n]+) -->/g)) {
      const parts = om[1].split("|").map(s => s.trim());
      opts.push({ label: parts[0] || "", desc: parts[1] || "", pros: parts[2] || "", cons: parts[3] || "" });
    }
    if (opts.length) decisions.push({ question: q, options: opts });
  }
  return decisions;
}

// ═══════════════════════════════════════
// 导出
// ═══════════════════════════════════════

export default function (pi: any) {

  // ── input: 确认词放行 + 决策点翻译层（不判档位）──
  pi.on("input", async (event: any, ctx: any) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (!spoqEnabled(cwd)) return { action: "continue" };
    let text = (event.text ?? "").trim();
    if (!text) return { action: "continue" };

    // 剥离 /impl 前缀
    if (text.startsWith("/impl")) text = text.replace(/^\/impl\s*/, "").trim();
    if (!text) return { action: "continue" };

    // ── 决策点翻译层（唯一保留的功能；不判档位、不拦截输入）──
    // 复杂度由主代理探索后自己判断，本扩展不做预分类。
    // 确认词/单字母无需特殊处理：本扩展不 transform 拦截，无决策点时原样返回（等同 continue）。
    let decisionText = "";
    try {
      const decisions = await detectDecisions(cwd, text);
      if (decisions.length > 0) {
        const picked: string[] = [];
        for (const d of decisions) {
          const opts = d.options.map(o => `${o.label}（${o.desc}）\n    👍 ${o.pros}\n    👎 ${o.cons}`);
          const sel = await ctx.ui.select(`需求决策：${d.question}（由你取舍，AI 不替你选）`, opts);
          if (sel) {
            const label = sel.split("（")[0].trim();
            picked.push(`${d.question} → 选 ${label}`);
          }
        }
        if (picked.length) {
          decisionText = "\n\n【用户已做的技术取舍】\n" + picked.map(p => `- ${p}`).join("\n");
          // 升级：选完后再让用户自由补充（约束/偏好/边界，空直接跳过）
          const extra = await ctx.ui.input(
            "还有补充吗？（工程约束/偏好/边界，直接回车跳过）",
            "",
          );
          if (extra && extra.trim()) {
            decisionText += "\n\n【用户补充】\n" + extra.trim();
          }
          text = text + decisionText;
        }
      }
    } catch {}
    appendAudit(cwd, { time: new Date().toISOString(), action: "translate", decisions: decisionText ? "asked" : "none" });
    return { action: "transform", text };
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
        `\n    ④ 用户取舍后需求和工程锁死 → 复杂度才可判 → 自己决定执行方式（SIMPLE 直接改 / 复杂并行 coder / 大型完整流程）` +
        `\n    禁止：想当然填自己熟悉的技术栈（如 web 套壳）而不给用户选；禁止替用户做技术选型决策。` +
        `\n【复杂度判断（自己探索后判，不靠预分类）】` +
        `\n    没有 Router 预分类标签。你收到任务后：` +
        `\n    ① 先探索摸现状（SIMPLE 也至少看一眼目标文件/依赖是否存在；复杂可派侦察员当你的手）` +
        `\n    ② 探索后自己判断：这活多大？——目标功能/依赖是否已存在（例：说"实现 live2d 眨眼"但项目没 live2d）、实际要改多少文件/新建模块/选架构/配测试、是否跨端` +
        `\n    ③ 按判断选执行方式：小 → 直接干；中 → 架构师出计划+并行 coder；大 → 完整五阶段（分解→契约→排班→TDD→收口）` +
        `\n【是否开干确认（强制）】` +
        `\n    探索+生成微计划后，【停下，向用户展示确认信息并问"是否开干"】，用户确认后再动手` +
        `\n    确认信息必须包含三部分：` +
        `\n    (a) 复杂度判定：你自己判断的规模 + 一句话理由` +
        `\n    (b) 改动预估：预估波及 N 文件 / M 任务` +
        `\n    (c) 微计划：改哪些文件/新建什么/怎么验证（≤5 行）` +
        `\n    探索后发现规模远超初判（例：说实现 X 但项目根本没有 X 的基础组件）→ 【停下，向用户展示探索发现 + 建议的方案，让用户重新裁定】` +
        `\n    禁止：跳过"是否开干"直接动手；禁止确认时不展示复杂度判定/改动预估/微计划。` +
        `\n- 派发子代理用 Agent 工具（run_in_background=true），子代理是手脚，派发后不阻塞等待，继续推进或等其完成事件。` +
        `\n- 子代理的工作目录是 ${cwd}，prompt 里直接给绝对路径，不要让子代理自己找项目。` +
        `\n- 大型任务五阶段：⓪任务分解（侦察员并行→任务清单+依赖分组→确认）→ ①契约（接口设计师+测试经理共同产出 contract-{module}.md）→ ②排班（测试经理按文件配对 tester+coder+文件锁）→ ③并行 TDD（tester 先写 RED→coder 实现 GREEN，失败经测试经理脱敏转发）→ ④收口（整体测试+错误分级：小错补丁/大错重写）。` +
        `\n- 中等任务：架构师（或你翻译后）出计划 → 是否开干确认 → 并行 TDD（多对 tester+coder，文件锁：coder 禁读 tests/、tester 禁读 src/）。` +
        `\n- 交接物固定写入 ${cwd}/.pi/spoq/（文件名见 SOP 5.0），路径在 prompt 里显式指定，子代理不得自创目录。` +
        `\n- 上下文瘦身：收到子代理完成通知后只记录指针（文件路径+一行摘要），绝不把交接物全文读进上下文。需要细节时再读文件。` +
        `\n- 遇到人工确认点（决策点取舍/是否开干/分解确认/契约确认/错误分级/探索后发现不符）→ 停下展示给用户，等回复后再继续。` +
        `\n- 子代理产出交接物必须符合 SOP.md 第 5 节 schema（字段齐全/来源存在），不合规打回该层重做。` +
        `\n- 你的记忆只来自当前对话上下文；任务完成或用户终止后，清空自己的"进行中"认知。` +
        `\n- 禁止：在用户没有回复菜单时自行替用户决策（Gate/模式选择/技术选型必须等用户）。` +
        `\n- 禁止：想当然填技术栈或假设需求细节（那是翻译层要问用户的）；禁止把模糊需求当已明确处理。` +
        `\n- 禁止：自己改生产代码行为逻辑（那是 coder 的活）——机械修复（import/依赖/格式）可做，行为修复必须派 coder 或标超范围。` +
        `\n- 【处理子代理的 [UNSURE] 上报（强制）】子代理遇到不确定会停止并上报 [UNSURE]，你必须：` +
        `\n    ① 能确定 → 直接给出答案，让子代理继续` +
        `\n    ② 不能确定但影响需求/架构 → 停下问用户（把不确定项翻译成非工程语言让用户确认）` +
        `\n    ③ 需要补充调研 → 派检索员/侦察员查证后再决定` +
        `\n    禁止：对 [UNSURE] 上报不理会、猜一个答案回给子代理、或让子代理自己猜。`,
    };
  });
}
