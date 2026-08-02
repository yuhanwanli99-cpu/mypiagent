/**
 * ZhipuAI Provider Extension for Pi
 * Registers Zhipu/GLM models as available providers
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("zhipu", {
    name: "ZhipuAI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions",
    // apiKey from auth.json — never hardcode credentials
    apiKey: undefined,
    models: [
      {
        id: "glm-4.7",
        name: "GLM-4.7",
        reasoning: true,
        input: ["text"],
        contextWindow: 204800,
        maxTokens: 131072,
        compat: { thinkingFormat: "zai" },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  });
}
