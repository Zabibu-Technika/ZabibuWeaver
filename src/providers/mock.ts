// Offline provider: replays a scripted list of turns. Lets the whole loop —
// streaming, tools, permissions, rendering — be exercised with no API key and
// no network. This is what makes the agent testable.
import { readFileSync } from "node:fs";
import type { AssistantTurn, ChatRequest, Delta, Provider, ToolCall } from "../core/types.ts";

export interface MockTurn {
  content?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> | string }>;
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function lastUserMessage(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const message = req.messages[i];
    if (message?.role === "user") return message.content ?? "";
  }
  return "";
}

export function createMockProvider(scriptPath: string | null): Provider {
  let script: MockTurn[] | null = null;
  if (scriptPath !== null) {
    try {
      script = JSON.parse(readFileSync(scriptPath, "utf8")) as MockTurn[];
    } catch {
      script = null;
    }
  }

  let index = 0;

  return {
    name: "mock",

    async chat(req: ChatRequest, onDelta: (delta: Delta) => void): Promise<AssistantTurn> {
      const turn: MockTurn =
        script !== null
          ? (script[index] ?? { content: "[mock] script exhausted" })
          : { content: `[mock] echo: ${lastUserMessage(req)}` };
      index += 1;

      const content = turn.content ?? "";
      for (const chunk of chunkText(content, 24)) {
        onDelta({ content: chunk });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((call, i) => ({
        id: `mock_${index}_${i}`,
        type: "function" as const,
        function: {
          name: call.name,
          arguments:
            typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
        },
      }));

      return { content, toolCalls, raw: content, recovered: false };
    },
  };
}
