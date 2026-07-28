import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Role = "architect" | "developer" | "tester" | "tester-visual" | null;

export default function (pi: ExtensionAPI) {
  // 修复 #5：去掉 session 级别的 done 标志。
  // 每个 before_agent_start 事件都独立注入 Phase 感知消息。
  // 之前的 done 全局标志导致只有第一个 agent 收到约束，其余 agent 裸奔。

  let currentCwd: string = process.cwd();
  // 当前进程对应的子代理角色（Orchestrator 本身为 null）。
  // 由 before_agent_start 探测一次，供 message_end / agent_end 复用。
  let currentRole: Role = null;
  let currentTaskId: string | null = null;
  // Tester/tester-visual 本次会话中实际执行过 bash 的次数，用于证据门禁。
  // 每次 before_agent_start（新子代理进程启动）时重置。
  let bashExecCount = 0;

  // P0-1: 角色 system prompt 不再由子代理自己 read agent-loops/*.md，
  // 而是由扩展在启动时直接读入并注入 systemPrompt，消除 56 次 read。
  pi.on("before_agent_start", async (event, ctx) => {
    currentCwd = ctx.cwd ?? currentCwd;
    const phase = determinePhase(currentCwd);
    const { role, taskId } = detectRole(event.prompt);
    currentRole = role;
    currentTaskId = taskId;
    bashExecCount = 0;

    let systemPrompt: string | undefined;
    if (role) {
      const roleDoc = loadRoleDoc(currentCwd, role);
      const lessons = loadRecentLessons(currentCwd, 3);
      const injected = [
        "\n\n---\n## [硬约束・不可忽略] 你的角色定义（由 spoq-enforcer 注入，取代 agent-loops/*.md 的软文本）",
        roleDoc ?? `(未找到 ${role} 的 agent-loop 定义文件)`,
        "\n## 最近教训（自动注入，无需再 read lessons-learned.md）",
        lessons ?? "（暂无教训记录）",
        "\n## 铁律重申",
        "- 你不是 Orchestrator，禁止拆任务、禁止派发子代理、禁止自称 Orchestrator/调度师。",
        "- 只做你角色范围内的事，产出后自然终止。",
      ].join("\n");
      systemPrompt = (event.systemPrompt ?? "") + injected;
    }

    return {
      message: {
        customType: "spoq-reminder",
        content: buildMessage(phase, role),
        display: false,
      },
      ...(systemPrompt ? { systemPrompt } : {}),
    };
  });

  // P1-1: 角色错乱检测。子代理若在输出中自称 Orchestrator / 尝试拆任务派代理，
  // 自动记录违规并写邮件通知 Orchestrator，而不是依赖子代理"自觉"上报。
  pi.on("message_end", async (event) => {
    if (!currentRole) return; // Orchestrator 自身不检测
    if (event.message?.role !== "assistant") return;

    const text = extractText(event.message);
    if (!text) return;

    const confusionPattern = /(作为\s*Orchestrator|我将.{0,6}调度|拆任务.{0,6}派(代理|Agent)|派发子代理|as\s+the\s+orchestrator|dispatch(ing)?\s+(a\s+)?sub-?agent)/i;
    if (confusionPattern.test(text)) {
      reportRoleConfusion(currentCwd, currentRole, currentTaskId, text);
    }
  });

  // P2: 上下文监控。每个 agent 结束时检查上下文占用，超阈值时提示/自动建议 compact。
  pi.on("agent_end", async (_event, ctx) => {
    try {
      const usage = ctx.getContextUsage?.();
      if (usage && typeof usage.percent === "number" && usage.percent >= 70) {
        console.error(
          `[spoq-enforcer] ⚠️ 上下文占用 ${usage.percent}%（role=${currentRole ?? "orchestrator"}），建议 /compact 或拆分任务。`
        );
      }
    } catch {
      // getContextUsage 不可用时静默跳过
    }
  });

  // P0-2: 转换表硬编码。在 write 真正落盘前拦截 spoq-state.json 的写入，
  // 校验每个 task 的 (oldState -> newState) 是否在硬转换表 T1-T16 内，
  // 非法迁移直接 block，Orchestrator 的写入请求根本不会执行（比写后回滚更干净）。
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;
    const cwd = ctx.cwd ?? currentCwd;
    const targetPath = resolveMaybeAbsolute(cwd, event.input.path);
    const spoqPath = join(cwd, ".pi", "spoq-state.json");
    if (targetPath !== spoqPath) return;

    let newState: any;
    try {
      newState = JSON.parse(event.input.content);
    } catch (e) {
      return { block: true, reason: `spoq-state.json 写入内容不是合法 JSON: ${e}` };
    }

    let oldState: any = null;
    if (existsSync(spoqPath)) {
      try {
        oldState = JSON.parse(readFileSync(spoqPath, "utf-8"));
      } catch {
        oldState = null; // 旧文件本身已损坏，交给 tool_execution_end 的备份恢复逻辑处理
      }
    }

    const violations = validateTransitions(oldState, newState);
    if (violations.length > 0) {
      appendTelemetry(cwd, {
        type: "transition_blocked",
        taskId: currentTaskId,
        role: currentRole,
        violations,
      });
      return {
        block: true,
        reason: `非法状态迁移，写入被拒绝（硬转换表 T1-T16 校验失败）:\n- ${violations.join("\n- ")}`,
      };
    }

    // 转换合法，记录本次实际发生的每个 task 状态迁移（遥测，供 task-telemetry-log 消费）。
    logAcceptedTransitions(cwd, oldState, newState);

    // P0-3: complexity / needsVisualEvidence 是主观判断字段，容易被弱模型标记
    // 错误（如把多文件改动标成 simple 以图省事跳过 Architect）。这里只做客观信号
    // 的一致性提醒，不 block（避免误伤真正合理的边界判断），写警告日志供人工/
    // Orchestrator 复核。
    const heuristicWarnings = checkComplexityHeuristics(newState);
    if (heuristicWarnings.length > 0) {
      console.error(
        `[spoq-enforcer] ⚠️ complexity/needsVisualEvidence 标注疑似与客观信号不符（仅提醒，不阻断）:\n- ${heuristicWarnings.join("\n- ")}`,
      );
      appendTelemetry(cwd, { type: "heuristic_warning", warnings: heuristicWarnings });
    }

    // task-schema-conformance-check：对刚进入 dev_done 的 complex 任务，做
    // plan-{id}.schema.json 与 srcPath 的静态一致性检查（仅警告，不阻断——
    // 正则/文本匹配本身有误报可能，真正的把关仍由 Tester + 严格 Gate 承担）。
    const schemaWarnings = checkSchemaConformanceForNewlyDone(cwd, oldState, newState);
    if (schemaWarnings.length > 0) {
      console.error(
        `[spoq-enforcer] ⚠️ schema 一致性检查发现疑似未实现项（仅提醒，不阻断）:\n- ${schemaWarnings.join("\n- ")}`,
      );
      appendTelemetry(cwd, { type: "schema_conformance_warning", warnings: schemaWarnings });
    }
  });

  // task-tester-evidence-gate：Tester 汇报 PASS 前必须拿得出真实证据——
  // 纯文本档（tester）要求本次会话确实调用过 bash；视觉档（tester-visual）
  // 要求报告里引用的截图/证据文件在磁盘上确实存在。任一缺失，直接 block
  // 这次 write，报告根本落不了盘，Tester 必须先补证据再重写。
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;
    if (currentRole !== "tester" && currentRole !== "tester-visual") return;

    const cwd = ctx.cwd ?? currentCwd;
    const targetPath = resolveMaybeAbsolute(cwd, event.input.path);
    if (!isTestReportPath(targetPath)) return;

    const content = event.input.content ?? "";
    if (!/结果\s*[:：]\s*PASS/i.test(content)) return; // 非 PASS 声明不做证据校验

    if (currentRole === "tester") {
      if (bashExecCount === 0) {
        appendTelemetry(cwd, { type: "evidence_gate_blocked", taskId: currentTaskId, role: currentRole, reason: "no_bash_execution" });
        return {
          block: true,
          reason:
            "证据门禁：报告声称 PASS，但本次会话未检测到任何真实 bash 执行记录。请先实际运行验证命令（如 pytest/npm test），再据其真实输出撰写报告。",
        };
      }
    } else {
      const evidencePaths = extractEvidencePaths(content);
      const existing = evidencePaths.filter((p) => existsSync(resolveMaybeAbsolute(cwd, p)));
      if (existing.length === 0) {
        appendTelemetry(cwd, { type: "evidence_gate_blocked", taskId: currentTaskId, role: currentRole, reason: "no_screenshot_evidence" });
        return {
          block: true,
          reason: "证据门禁：视觉验证报告声称 PASS，但未找到任何存在于磁盘上的截图/证据文件路径。请附上真实截图路径（磁盘可访问）。",
        };
      }
    }
  });

  // 配合证据门禁：统计本次子代理会话实际执行过的 bash 次数（仅成功执行计数）。
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "bash" && !event.isError && (currentRole === "tester" || currentRole === "tester-visual")) {
      bashExecCount++;
    }
  });

  // 修复 #4：监听 write/edit 操作，自动备份和校验 spoq-state.json
  // 【修复】原代码用的是 "after_tool_call"，这不是本框架的合法事件名
  // （官方 types.d.ts 里只有 tool_call / tool_execution_end / tool_result），
  // 导致这个 handler 从未真正注册、从未执行过。改用 tool_execution_end。
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    // 检查是否修改了 spoq-state.json
    const spoqPath = join(currentCwd, ".pi", "spoq-state.json");
    if (!existsSync(spoqPath)) return;

    // 校验 JSON 有效性
    try {
      const content = readFileSync(spoqPath, "utf-8");
      const state = JSON.parse(content);
      const invariantErrors = validateStateMachineInvariants(currentCwd, state);
      if (invariantErrors.length > 0) {
        throw new Error(`状态机约束违反:\n- ${invariantErrors.join("\n- ")}`);
      }
    } catch (e) {
      // JSON 破损 — 尝试从备份恢复
      const backupPath = spoqPath + ".backup";
      if (existsSync(backupPath)) {
        try {
          const backup = readFileSync(backupPath, "utf-8");
          JSON.parse(backup); // 确认备份有效
          writeFileSync(spoqPath, backup, "utf-8");
          console.error(
            `[spoq-enforcer] ⚠️ spoq-state.json 损坏，已从备份恢复。错误: ${e}`
          );
        } catch {
          console.error(
            `[spoq-enforcer] 🔴 spoq-state.json 损坏且备份无效！请手动修复。错误: ${e}`
          );
        }
      } else {
        console.error(
          `[spoq-enforcer] 🔴 spoq-state.json 损坏且无备份！错误: ${e}`
        );
      }
      return;
    }

    // JSON 有效 — 创建备份
    try {
      const content = readFileSync(spoqPath, "utf-8");
      writeFileSync(spoqPath + ".backup", content, "utf-8");
    } catch {
      // 备份失败不影响主流程
    }
  });
}

/**
 * 硬转换表（对应 spoq-state.schema.md 的 T1-T16）。
 * key = 当前状态，value = 该状态允许迁移到的下一状态集合。
 * "*" 表示任何状态都可能迁移到该目标（用于 blocked 这个安全阀）。
 */
const TRANSITION_TABLE: Record<string, string[]> = {
  pending: ["architecting", "developing", "blocked"], // T1 / T1a
  architecting: ["architecting", "plan_done", "done", "blocked"], // T2 / T3(重试原地) / T4
  plan_done: ["developing", "blocked"], // T5
  developing: ["developing", "dev_done", "done", "blocked"], // T6 / T6a,T7(重试原地) / T8
  dev_done: ["testing", "blocked"], // T9
  testing: ["testing", "done", "developing", "architecting", "blocked"], // T13(重试原地) / T10,T12,T14 / T11 / T11a
  blocked: ["pending", "architecting", "plan_done", "developing", "dev_done", "testing", "done"], // T15，人工解除，允许回退到任意历史状态
  done: ["done"], // T16，lowQualityPass 等效终态，等幂
};

/**
 * 校验 newState 相对 oldState 里每个任务的 state 变化是否落在硬转换表内。
 * - oldState 为 null（首次创建文件）时不校验迁移，只校验新任务必须从 pending 开始。
 * - 只校验 state 字段变化的任务，未变化的任务不检查（避免误伤纯字段更新，如补 lessons）。
 */
function validateTransitions(oldState: any, newState: any): string[] {
  const errors: string[] = [];
  const newTasks: Record<string, any> = newState?.dag?.tasks ?? {};

  if (!oldState) {
    for (const [taskId, task] of Object.entries(newTasks)) {
      const s = (task as any)?.state;
      if (s !== undefined && s !== "pending") {
        errors.push(`${taskId}: 首次创建任务必须从 pending 开始，实际为 ${s}`);
      }
    }
    return errors;
  }

  const oldTasks: Record<string, any> = oldState?.dag?.tasks ?? {};

  for (const [taskId, task] of Object.entries(newTasks)) {
    const newTaskState = (task as any)?.state;
    if (typeof newTaskState !== "string") continue;

    const oldTask = oldTasks[taskId];
    if (!oldTask) {
      // 新出现的任务：只允许从 pending 开始
      if (newTaskState !== "pending") {
        errors.push(`${taskId}: 新任务必须从 pending 开始，实际为 ${newTaskState}`);
      }
      continue;
    }

    const oldTaskState = oldTask?.state;
    if (typeof oldTaskState !== "string" || oldTaskState === newTaskState) continue; // 未变化，跳过

    const allowed = TRANSITION_TABLE[oldTaskState];
    if (!allowed) {
      errors.push(`${taskId}: 未知的原状态 "${oldTaskState}"，无法校验迁移`);
      continue;
    }
    if (!allowed.includes(newTaskState)) {
      errors.push(`${taskId}: 非法迁移 ${oldTaskState} → ${newTaskState}（不在硬转换表允许范围: ${allowed.join(",")}）`);
    }
  }

  return errors;
}

/** 把 write 工具的 path 参数（可能是相对路径或绝对路径）归一化为绝对路径以便比较。 */
function resolveMaybeAbsolute(cwd: string, p: string): string {
  if (!p) return p;
  return p.includes(":") || p.startsWith("/") || p.startsWith("\\") ? p : join(cwd, p);
}

/** 遥测落盘：每行一个 JSON 对象，追加到 .pi/spoq-telemetry.jsonl。失败不影响主流程。 */
function appendTelemetry(cwd: string, record: Record<string, unknown>) {
  try {
    const dir = join(cwd, ".pi");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    appendFileSync(join(dir, "spoq-telemetry.jsonl"), line, "utf-8");
  } catch {
    // 遥测失败不影响主流程
  }
}

/** 记录本次写入实际发生的每个 task 状态迁移（写入尚未真正落盘，但已通过校验，视为将要发生）。 */
function logAcceptedTransitions(cwd: string, oldState: any, newState: any): void {
  const oldTasks: Record<string, any> = oldState?.dag?.tasks ?? {};
  const newTasks: Record<string, any> = newState?.dag?.tasks ?? {};
  for (const [taskId, task] of Object.entries(newTasks)) {
    const newTaskState = (task as any)?.state;
    if (typeof newTaskState !== "string") continue;
    const oldTaskState = oldTasks[taskId]?.state;
    if (oldTaskState === newTaskState) continue;
    appendTelemetry(cwd, {
      type: "transition",
      taskId,
      from: oldTaskState ?? null,
      to: newTaskState,
      agentType: (task as any)?.agentType ?? null,
      retryCount: (task as any)?.retryCount ?? null,
    });
  }
}

/** 判断 path 是否是测试报告文件（.pi/spoq-mailbox/{task}/test-{task}.md 或 docs/test-{task}.md）。 */
function isTestReportPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  return /\/\.pi\/spoq-mailbox\/[^/]+\/test-[^/]+\.md$/i.test(norm) || /\/docs\/test-[^/]+\.md$/i.test(norm);
}

/** 从报告文本里提取截图/证据文件路径（markdown 图片语法 + 裸路径）。 */
function extractEvidencePaths(content: string): string[] {
  const paths = new Set<string>();
  const mdImage = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdImage.exec(content))) paths.add(m[1]);
  const bareImage = /[^\s"'()]+\.(png|jpe?g|gif|webp|bmp)\b/gi;
  while ((m = bareImage.exec(content))) paths.add(m[0]);
  return Array.from(paths);
}

/** UI/视觉相关关键词与路径特征，用于客观判断某任务是否"看起来"需要视觉证据。 */
const VISUAL_SIGNAL_PATTERN = /\.(wxml|wxss|css|scss)\b|screenshot|截图|UI|界面|布局|样式|像素|px\b/i;
/** 多文件/多模块信号：描述里出现文件列表、"多个文件"、"3+"、模块名并列等。 */
const COMPLEX_SIGNAL_PATTERN = /\b3\+|多个文件|多模块|架构|新增模块|schema\s*变更|API\s*契约/i;

/**
 * 对 complexity / needsVisualEvidence 字段做客观信号一致性检查（仅警告，不阻断）。
 * - needsVisualEvidence=false 但 description 命中视觉关键词 → 提醒可能漏标
 * - complexity="simple" 但 description 命中复杂信号 → 提醒可能漏标
 * 只检查有 description 字段的任务，避免对纯字段更新做无意义提醒。
 */
function checkComplexityHeuristics(state: any): string[] {
  const warnings: string[] = [];
  const tasks: Record<string, any> = state?.dag?.tasks ?? {};

  for (const [taskId, task] of Object.entries(tasks)) {
    const description: string = (task as any)?.description ?? "";
    if (!description) continue;

    const needsVisual = (task as any)?.needsVisualEvidence;
    if (needsVisual === false && VISUAL_SIGNAL_PATTERN.test(description)) {
      warnings.push(`${taskId}: description 含视觉/UI 关键词，但 needsVisualEvidence=false，请复核是否应派 tester-visual`);
    }

    const complexity: string | undefined = (task as any)?.complexity;
    if (complexity === "simple" && COMPLEX_SIGNAL_PATTERN.test(description)) {
      warnings.push(`${taskId}: description 含多文件/架构变更信号，但 complexity=simple，请复核是否应走完整 Architect→Developer→Tester 链路`);
    }
  }

  return warnings;
}

/**
 * task-schema-conformance-check：对新进入 dev_done 的 complex 任务，做
 * plan-{id}.schema.json（Architect 产出的结构化接口契约）与 srcPath 实现的
 * 静态一致性检查——纯文本匹配，不解析 AST，只作为 Tester 之外的第二道
 * 机械校验（宁可漏报也不误伤，故只警告不阻断）。
 */
function checkSchemaConformanceForNewlyDone(cwd: string, oldState: any, newState: any): string[] {
  const warnings: string[] = [];
  const oldTasks: Record<string, any> = oldState?.dag?.tasks ?? {};
  const newTasks: Record<string, any> = newState?.dag?.tasks ?? {};

  for (const [taskId, task] of Object.entries(newTasks)) {
    const newTaskState = (task as any)?.state;
    if (newTaskState !== "dev_done") continue;
    if (oldTasks[taskId]?.state === "dev_done") continue; // 只在刚进入时检查一次

    warnings.push(...checkSchemaConformance(cwd, task as any, taskId));
  }

  return warnings;
}

function checkSchemaConformance(cwd: string, task: any, taskId: string): string[] {
  if (task?.complexity !== "complex") return []; // 只对有 schema 契约的 complex 任务有意义

  const schemaCandidates = [
    join(cwd, ".pi", "spoq-mailbox", taskId, `plan-${taskId}.schema.json`),
    join(cwd, "docs", `plan-${taskId}.schema.json`),
  ];
  const schemaPath = schemaCandidates.find((p) => existsSync(p));
  if (!schemaPath) return []; // 没有 schema 契约文件，跳过（不是所有任务都强制要求）

  const srcPath = task?.srcPath ? resolveMaybeAbsolute(cwd, String(task.srcPath)) : null;
  if (!srcPath || !existsSync(srcPath)) return [];

  let schema: any;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  } catch {
    return []; // schema 本身解析失败，不在本检查职责范围内
  }

  const names = collectSchemaNames(schema);
  if (names.length === 0) return [];

  const srcText = collectSourceText(srcPath);
  const missing = names.filter((n) => n.length >= 2 && !srcText.includes(n));
  if (missing.length === 0) return [];

  return [`${taskId}: schema 中定义的以下标识符在 src/${taskId}/ 源码文本中未找到任何匹配，疑似未实现或命名不一致: ${missing.slice(0, 10).join(", ")}`];
}

/** 递归收集 schema JSON 里疑似"标识符"的字符串值（函数名/字段名/端点路径等常见 key）。 */
function collectSchemaNames(node: any, depth = 0): string[] {
  if (depth > 6 || node == null) return [];
  const names: string[] = [];
  const NAME_KEYS = /^(name|function|functionName|field|fieldName|method|endpoint|path|route)$/i;

  if (Array.isArray(node)) {
    for (const item of node) names.push(...collectSchemaNames(item, depth + 1));
  } else if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (NAME_KEYS.test(key) && typeof value === "string") {
        names.push(value);
      } else {
        names.push(...collectSchemaNames(value, depth + 1));
      }
    }
  }
  return names;
}

/** 浅层递归读取 srcPath 下的源码文本（限制文件数/总大小，避免大目录拖慢写入路径）。 */
function collectSourceText(srcPath: string, maxFiles = 60, maxBytesPerFile = 200_000): string {
  const chunks: string[] = [];
  let fileCount = 0;

  function walk(dir: string, depth: number) {
    if (depth > 5 || fileCount >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= maxFiles) return;
      if (entry === "node_modules" || entry === ".git") continue;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full, depth + 1);
      } else {
        try {
          const content = readFileSync(full, "utf-8");
          chunks.push(content.slice(0, maxBytesPerFile));
          fileCount++;
        } catch {
          // 二进制文件等读取失败，跳过
        }
      }
    }
  }

  walk(srcPath, 0);
  return chunks.join("\n");
}

/**
 * 读取并解析 .pi/spoq-state.json，返回 phase 和是否有活跃任务。
 * 任何异常（文件不存在、解析失败等）均返回 null → 安全降级为 Phase 0。
 */
function readSpoqState(cwd: string): { phase: string; hasActiveTasks: boolean } | null {
  try {
    const content = readFileSync(join(cwd, ".pi", "spoq-state.json"), "utf-8");
    const state = JSON.parse(content);
    const tasks: Record<string, any> = state.dag?.tasks ?? {};
    const hasActiveTasks = Object.values(tasks).some(
      (t) => t.agentId != null && ["architecting", "developing", "testing"].includes(t.state),
    );
    return { phase: state.phase ?? "unknown", hasActiveTasks };
  } catch {
    return null;
  }
}

type Phase = "phase0" | "phase2";

/**
 * 根据状态文件内容判断当前 Phase。
 * - 文件不存在或解析失败 → Phase 0（安全降级）
 * - phase=planning 或 done → Phase 0
 * - phase=executing → Phase 2（无论是否空闲，保持执行约束）
 * - 未知 phase → Phase 0
 */
function determinePhase(cwd: string): Phase {
  const info = readSpoqState(cwd);
  if (!info) return "phase0";
  if (info.phase === "planning") return "phase0";
  if (info.phase === "done") return "phase0";
  if (info.phase === "executing") return "phase2";
  return "phase0";
}

/**
 * 根据 Phase（和已探测到的子代理角色）生成对应的 Agent 约束消息。
 */
function buildMessage(phase: Phase, role: Role): string {
  if (role) {
    // 子代理：完整角色定义已通过 systemPrompt 注入，这里只放极简提醒，
    // 避免与注入内容重复占用上下文。
    return `## 你是 ${role}\n完整角色约束已注入 system prompt。你不是 Orchestrator，不要拆任务/派代理，只做你角色范围内的事。`;
  }
  if (phase === "phase0") {
    return (
      "## 当前阶段：Phase 0（规划）\n" +
      "- 主代理(Orchestrator)：允许读代码/搜索/拆解/写配置。收到需求后：拆子任务DAG→排Wave→派Agent。\n" +
      "- 简单任务直接派，复杂任务先输出拆解给用户确认。"
    );
  }
  return (
    "## 当前阶段：Phase 2（执行-状态机模式）\n" +
    "- 主代理(Orchestrator)：严格按硬转换表执行 LOAD→POLL→APPLY→FIND→DISPATCH→SAVE→CHECK。禁止读源码/写代码。\n" +
    "- 产物路径优先级：.pi/spoq-mailbox/{task}/... 优先，docs/... 兜底。\n" +
    "- testing→done 严格门禁：仅接受 PASS，出现 FAIL / CONDITIONAL PASS / with reservations 必须回退。"
  );
}

/**
 * 从 Orchestrator 派发给子代理的 prompt 文本中探测角色和 task-id。
 * 依据 AGENTS.md「构建子代理 Prompt」模板：包含 "## 你的角色" + 角色名，
 * 以及 "邮箱" 段落中的 .pi/spoq-mailbox/{task-id}/ 路径。
 */
function detectRole(prompt: string): { role: Role; taskId: string | null } {
  if (!prompt) return { role: null, taskId: null };

  let role: Role = null;
  if (/软件架构师|software-architect|你的角色[\s\S]{0,30}architect/i.test(prompt)) {
    role = "architect";
  } else if (/你的角色[\s\S]{0,30}developer|^##\s*角色[\s\S]{0,10}开发者/im.test(prompt)) {
    role = "developer";
  } else if (/tester-visual|你的角色[\s\S]{0,30}tester-visual/i.test(prompt)) {
    role = "tester-visual";
  } else if (/你的角色[\s\S]{0,30}tester|测试者\s*[—-]\s*验证/i.test(prompt)) {
    role = "tester";
  }

  const taskIdMatch = prompt.match(/spoq-mailbox[\\/]([a-zA-Z0-9._-]+)[\\/]/);
  const taskId = taskIdMatch ? taskIdMatch[1] : null;

  return { role, taskId };
}

/** 读取角色定义文件（agent-loops/{role}.md 或 software-architect.md），带简单缓存。 */
const roleDocCache = new Map<string, { mtimeMs: number; content: string }>();

function loadRoleDoc(cwd: string, role: Exclude<Role, null>): string | null {
  // tester-visual 没有独立的 agent-loops 文档，优先找专属文件，
  // 找不到则退回共享的 tester.md（其真正的完整指令已经由 tester-visual.md
  // 的 frontmatter body 通过 prompt_mode: replace 提供，这里只是补充）。
  const candidates =
    role === "architect" ? ["architect.md"] : role === "tester-visual" ? ["tester-visual.md", "tester.md"] : [`${role}.md`];

  for (const fileName of candidates) {
    const path = join(cwd, ".pi", "agent-loops", fileName);
    if (!existsSync(path)) continue;
    try {
      const stat = statSync(path);
      const cached = roleDocCache.get(path);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content;
      const content = readFileSync(path, "utf-8");
      roleDocCache.set(path, { mtimeMs: stat.mtimeMs, content });
      return content;
    } catch {
      continue;
    }
  }
  return null;
}

/** 从 lessons-learned.md 中提取最近 N 条 "- **日期**:" 起始的教训条目。 */
function loadRecentLessons(cwd: string, n: number): string | null {
  const path = join(cwd, ".pi", "lessons-learned.md");
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const entries = content
      .split(/\n(?=- \*\*日期\*\*:)/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("- **日期**:"));
    if (entries.length === 0) return null;
    return entries.slice(-n).join("\n\n");
  } catch {
    return null;
  }
}

/** 提取 assistant 消息的纯文本内容，兼容 string 或 content block 数组两种形态。 */
function extractText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
  }
  return "";
}

/** 子代理角色错乱时自动写邮件通知 Orchestrator，不依赖子代理自觉上报。 */
function reportRoleConfusion(cwd: string, role: Exclude<Role, null>, taskId: string | null, evidence: string) {
  const dir = join(cwd, ".pi", "spoq-mailbox", taskId ?? "_unknown");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // 目录已存在或创建失败，继续尝试写入
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `any→orchestrator-${ts}.md`);
  const snippet = evidence.slice(0, 500);
  const body =
    `# 角色错乱自动检测\n\n` +
    `- 角色: ${role}\n` +
    `- 任务: ${taskId ?? "未知"}\n` +
    `- 时间: ${new Date().toISOString()}\n\n` +
    `## 证据片段\n\n${snippet}\n\n` +
    `> 由 spoq-enforcer.ts 的 message_end 钩子自动检测并写入，非子代理自愿上报。请退回该任务重新派发并在 prompt 中重申角色约束。\n`;
  try {
    writeFileSync(path, body, "utf-8");
    console.error(`[spoq-enforcer] 🔴 检测到角色错乱 (${role}/${taskId}) → ${path}`);
  } catch (e) {
    console.error(`[spoq-enforcer] 写角色错乱邮件失败: ${e}`);
  }
}

function validateStateMachineInvariants(cwd: string, state: any): string[] {
  const errors: string[] = [];
  const phase = state?.phase;
  const currentWave = typeof state?.currentWave === "number" ? state.currentWave : -1;
  const lessons = Array.isArray(state?.lessons) ? state.lessons : [];
  const tasks: Record<string, any> = state?.dag?.tasks ?? {};

  if (phase === "executing" && currentWave >= 1 && lessons.length === 0) {
    errors.push("phase=executing 且 currentWave>=1 时 lessons[] 不能为空");
  }

  for (const [taskId, task] of Object.entries(tasks)) {
    const currentState = task?.state;
    if (typeof currentState !== "string") {
      errors.push(`${taskId}: 缺少 state 字段`);
      continue;
    }

    if (!Array.isArray(task?.transitionLog)) {
      errors.push(`${taskId}: transitionLog 不是数组`);
    }

    if (
      phase === "executing" &&
      currentState !== "pending" &&
      currentState !== "blocked" &&
      Array.isArray(task?.transitionLog) &&
      task.transitionLog.length === 0
    ) {
      errors.push(`${taskId}: ${currentState} 状态缺少 transitionLog 记录`);
    }

    if (phase === "executing") {
      const isComplex = task?.complexity === "complex";
      const needsPlan =
        isComplex &&
        ["plan_done", "developing", "dev_done", "testing"].includes(currentState);
      if (needsPlan && !resolvePlanPath(cwd, taskId, task?.planPath)) {
        errors.push(`${taskId}: ${currentState} 状态缺少有效 planPath`);
      }

      const needsSrc = ["dev_done", "testing"].includes(currentState);
      if (needsSrc && !resolveSrcPath(cwd, task?.srcPath)) {
        errors.push(`${taskId}: ${currentState} 状态缺少有效 srcPath`);
      }
    }

    if (
      currentState === "done" &&
      task?.lowQualityPass !== true &&
      wasTestingTask(task)
    ) {
      const reportPath = resolveTestReportPath(cwd, taskId, task?.testPath);
      if (!reportPath) {
        errors.push(`${taskId}: done 任务缺少测试报告路径`);
      } else {
        const content = readFileSync(reportPath, "utf-8");
        if (!isStrictPassReport(content)) {
          errors.push(`${taskId}: 测试报告非严格 PASS (${reportPath})`);
        }
      }
    }
  }

  return errors;
}

function wasTestingTask(task: any): boolean {
  const testPath = task?.testPath;
  if (typeof testPath === "string" && testPath.length > 0) return true;
  const log = Array.isArray(task?.transitionLog) ? task.transitionLog : [];
  return log.some((entry: any) => entry?.from === "testing" || entry?.to === "testing");
}

function resolveTestReportPath(cwd: string, taskId: string, explicitPath: string | null | undefined): string | null {
  if (typeof explicitPath === "string" && explicitPath.length > 0) {
    const absolute = explicitPath.includes(":") ? explicitPath : join(cwd, explicitPath);
    if (existsSync(absolute)) return absolute;
  }

  const mailboxPath = join(cwd, ".pi", "spoq-mailbox", taskId, `test-${taskId}.md`);
  if (existsSync(mailboxPath)) return mailboxPath;

  const docsPath = join(cwd, "docs", `test-${taskId}.md`);
  if (existsSync(docsPath)) return docsPath;

  return null;
}

function resolvePlanPath(cwd: string, taskId: string, explicitPath: string | null | undefined): string | null {
  if (typeof explicitPath === "string" && explicitPath.length > 0) {
    const absolute = explicitPath.includes(":") ? explicitPath : join(cwd, explicitPath);
    if (existsSync(absolute)) return absolute;
  }

  const mailboxPath = join(cwd, ".pi", "spoq-mailbox", taskId, `plan-${taskId}.md`);
  if (existsSync(mailboxPath)) return mailboxPath;

  const docsPath = join(cwd, "docs", `plan-${taskId}.md`);
  if (existsSync(docsPath)) return docsPath;

  return null;
}

function resolveSrcPath(cwd: string, explicitPath: string | null | undefined): string | null {
  if (typeof explicitPath !== "string" || explicitPath.length === 0) return null;
  const absolute = explicitPath.includes(":") ? explicitPath : join(cwd, explicitPath);
  return existsSync(absolute) ? absolute : null;
}

function isStrictPassReport(report: string): boolean {
  const hasPassHeader = /##\s*(结果|result)\s*:\s*pass\b/i.test(report);
  const hasForbiddenMarkers = /\bfail\b|conditional\s*pass|with\s+reservations/i.test(report);
  return hasPassHeader && !hasForbiddenMarkers;
}
