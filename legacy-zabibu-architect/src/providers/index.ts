// Provider selection. One client, many endpoints.
import type { Provider } from "../core/types.ts";
import type { WeaverConfig } from "../config.ts";
import { createOpenAIProvider } from "./openai.ts";
import { createMockProvider } from "./mock.ts";

export function createProvider(cfg: WeaverConfig): Provider {
  if (cfg.provider === "mock") return createMockProvider(cfg.mockScript);

  if (cfg.endpoint === null) {
    throw new Error(
      `provider "${cfg.provider}" has no endpoint — set WEAVER_BASE_URL, or pick one of: mock, pollinations, groq, gemini, openrouter, ollama, openai, together`,
    );
  }

  return createOpenAIProvider({
    name: cfg.provider,
    baseUrl: cfg.endpoint,
    apiKey: cfg.apiKey,
    nativeTools: cfg.nativeTools,
  });
}
