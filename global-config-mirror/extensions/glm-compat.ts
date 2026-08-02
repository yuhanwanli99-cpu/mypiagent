/**
 * GLM Compat Extension — fixes GLM 400 for zai-coding-cn / z.ai only.
 *
 * Root cause (pi issue #547): z.ai's GLM API rejects messages from
 * other models (system role, tool messages, role alternation).
 *
 * IMPORTANT: zhipu direct (open.bigmodel.cn) does NOT need this —
 * it handles standard OpenAI format. Only zai-coding-cn is transformed.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── helpers ──────────────────────────────────────────────

function isGLMModel(modelId: string): boolean {
  if (!modelId) return false;
  return /^glm-/i.test(modelId);
}

/** Check if this is a zai-coding-cn / z.ai model (not zhipu direct) */
function isZaiModel(modelId: string): boolean {
  // zai-coding-cn GLM models start with "glm-"
  // But we need to distinguish from zhipu which also starts with "glm-"
  // Strategy: check ctx.model.provider in the handler
  return typeof modelId === "string" && /^glm-/i.test(modelId);
}

function targetsZaiProvider(payload: Record<string, unknown>, ctxProvider: string | undefined): boolean {
  const model = payload["model"];
  if (typeof model !== "string" || !isGLMModel(model)) return false;
  // Only transform for zai providers, NOT zhipu (which works fine natively)
  if (ctxProvider === "zai-coding-cn" || ctxProvider === "zai") return true;
  // If unknown provider but model is GLM, be conservative: skip
  return false;
}

function getStringContent(msg: Record<string, unknown>): string {
  const content = msg["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(function (b: Record<string, unknown>) {
        if (b["type"] === "text") return String(b["text"] || "");
        if (b["type"] === "toolCall") {
          const fn = (b["function"] || b) as Record<string, unknown>;
          const name = String(fn["name"] || "unknown");
          const args = String(fn["arguments"] || "");
          return "[Tool call: " + name + "(" + args.slice(0, 200) + ")]";
        }
        return "";
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

// ── transforms ───────────────────────────────────────────

/**
 * Merge system message into the first user message.
 */
function mergeSystemIntoUser(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const systemIdx = messages.findIndex(function (m) {
    const role = m["role"];
    return role === "system" || role === "developer";
  });
  if (systemIdx === -1) return messages;

  const systemMsg = messages[systemIdx];
  const systemContent = getStringContent(systemMsg);

  // Find first user message AFTER system
  const userIdx = messages.findIndex(function (m, i) {
    return i > systemIdx && m["role"] === "user";
  });

  const cleaned = messages.filter(function (_, i) { return i !== systemIdx; });

  if (userIdx !== -1) {
    const adjustedUserIdx = userIdx > systemIdx ? userIdx - 1 : userIdx;
    const userMsg = cleaned[adjustedUserIdx];
    const prefix = "[System instructions]\n" + systemContent + "\n\n---\n\n";
    const existingContent = userMsg["content"];
    if (typeof existingContent === "string") {
      userMsg["content"] = prefix + existingContent;
    } else if (Array.isArray(existingContent)) {
      userMsg["content"] = [{ type: "text", text: prefix }].concat(existingContent);
    }
  }

  return cleaned;
}

/**
 * Convert tool messages (role: "tool") to assistant messages.
 */
function convertToolMessages(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.map(function (msg) {
    if (msg["role"] !== "tool") return msg;

    const toolCallId = String(msg["tool_call_id"] || "unknown");
    const content = getStringContent(msg);

    return {
      role: "assistant",
      content: "[Tool result for " + toolCallId + "]\n" + content,
    };
  });
}

/**
 * Flatten assistant content: convert toolCall blocks to text notes.
 */
function flattenAssistantContent(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.map(function (msg) {
    if (msg["role"] !== "assistant") return msg;
    const content = msg["content"];
    if (typeof content === "string") return msg;
    if (!Array.isArray(content)) return msg;

    let hasToolCalls = false;
    for (let i = 0; i < content.length; i++) {
      if ((content[i] as Record<string, unknown>)["type"] === "toolCall") {
        hasToolCalls = true;
        break;
      }
    }

    if (!hasToolCalls) return msg;

    // Rebuild as string
    const newContent = getStringContent(msg);
    return { role: "assistant", content: newContent || "(tool calls)" };
  });
}

/**
 * Ensure strict user/assistant role alternation.
 */
function ensureRoleAlternation(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  if (messages.length < 2) return messages;

  const result: Record<string, unknown>[] = [messages[0]];
  const ALLOWED_ROLES = new Set(["user", "assistant", "system"]);

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];
    const currRole = String(curr["role"] || "");

    if (!ALLOWED_ROLES.has(currRole)) {
      result.push(curr);
      continue;
    }

    if (currRole === "system") continue;

    if (prev["role"] === currRole) {
      const prevContent = getStringContent(prev);
      const currContent = getStringContent(curr);
      prev["content"] = prevContent + "\n\n" + currContent;
    } else {
      result.push(curr);
    }
  }

  if (result.length > 0 && result[0]["role"] === "assistant") {
    result.unshift({
      role: "user",
      content: "[Start of conversation]",
    });
  }

  return result;
}

/**
 * Main transformation pipeline for GLM-bound messages.
 */
function transformForGLM(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  let msgs = mergeSystemIntoUser(messages);
  msgs = convertToolMessages(msgs);
  msgs = flattenAssistantContent(msgs);
  msgs = ensureRoleAlternation(msgs);
  return msgs;
}

// ── extension entry ──────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async function (event: any, ctx: any) {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    // Get provider name from ctx — only transform zai-coding-cn / zai
    let ctxProvider: string | undefined;
    try {
      const m = ctx.model;
      ctxProvider = (m && typeof m === "object") ? String(m.provider || "") : undefined;
    } catch {
      // ctx.model might not be available in all contexts
    }

    if (!targetsZaiProvider(payload, ctxProvider)) {
      return; // pass through unchanged (zhipu or non-GLM)
    }

    const msgs = (payload["messages"] as Record<string, unknown>[]) || [];
    const originalCount = msgs.length;
    payload["messages"] = transformForGLM(msgs);
    const transformedCount = (payload["messages"] as unknown[]).length;

    if (transformedCount !== originalCount) {
      console.error(
        "[glm-compat] Transformed " + originalCount + " -> " + transformedCount +
        " messages for " + ctxProvider + "/" + String(payload["model"] || "?")
      );
    }

    return payload;
  });
}
