// Any OpenAI-compatible chat endpoint (Groq, Gemini, OpenRouter, Ollama,
// Pollinations…). Streaming, native tool calls, and a real recovery path for
// malformed tool output.
//
// Two things separate this from a naive client:
//   1. Not every endpoint honours `stream: true`. Pollinations, for instance,
//      answers with a single JSON body. We detect the content type and handle
//      both, pacing the non-streamed answer so the UI still feels alive.
//   2. Not every endpoint honours `tools`. When it does not, the system prompt
//      teaches the model a textual tool protocol and the salvage parser below
//      picks it back up.
import type { AssistantTurn, ChatRequest, Delta, Provider, ToolCall } from "../core/types.ts";
import { extractToolCalls } from "./toolcalls.ts";

export interface OpenAIProviderOptions {
  name: string;
  /** The full chat-completions URL, already assembled by config. */
  baseUrl: string;
  apiKey: string;
  nativeTools: boolean;
  extraHeaders?: Record<string, string>;
}

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
}

interface DeltaShape {
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface MessageShape {
  content?: unknown;
  tool_calls?: unknown;
}

/** Chunk size and delay used to replay a non-streamed answer as a stream. */
const REPLAY_CHUNK = 90;
const REPLAY_DELAY_MS = 12;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripFunctionTags(text: string): string {
  const cut = text.search(/<function=/);
  const head = cut === -1 ? text : text.slice(0, cut);
  return head.replace(/<\/?function[^>]*>/g, "").trim();
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    // Some endpoints return content as parts: [{ type: "text", text: "…" }].
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

/** Normalise a native `tool_calls` array from either a stream or a full body. */
function toNativeCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];

  raw.forEach((entry, index) => {
    const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof call.function?.name === "string" ? call.function.name : "";
    if (name.length === 0) return;

    const rawArgs = call.function?.arguments;
    const args =
      typeof rawArgs === "string"
        ? rawArgs
        : rawArgs === undefined || rawArgs === null
          ? "{}"
          : JSON.stringify(rawArgs);

    calls.push({
      id: typeof call.id === "string" && call.id.length > 0 ? call.id : `call_${index}`,
      type: "function",
      function: { name, arguments: args },
    });
  });

  return calls;
}

async function consumeSse(res: Response, onData: (data: string) => void): Promise<void> {
  const body = res.body;
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
      newline = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail.startsWith("data:")) onData(tail.slice(5).trim());
}

async function readStreamed(
  res: Response,
  onDelta: (delta: Delta) => void,
): Promise<{ content: string; calls: ToolCall[] }> {
  const calls = new Map<number, ToolAccumulator>();
  let content = "";

  await consumeSse(res, (data) => {
    if (data === "[DONE]" || data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const choices = (parsed as { choices?: Array<{ delta?: DeltaShape }> }).choices;
    const delta = choices?.[0]?.delta;
    if (delta === undefined) return;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      onDelta({ content: delta.content });
    }

    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      const acc = calls.get(index) ?? { id: "", name: "", args: "" };
      if (typeof call.id === "string") acc.id = call.id;
      if (typeof call.function?.name === "string") acc.name += call.function.name;
      if (typeof call.function?.arguments === "string") acc.args += call.function.arguments;
      calls.set(index, acc);
    }
  });

  const native: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, acc]) => acc.name.length > 0)
    .map(([index, acc]) => ({
      id: acc.id.length > 0 ? acc.id : `call_${index}`,
      type: "function" as const,
      function: { name: acc.name, arguments: acc.args.length > 0 ? acc.args : "{}" },
    }));

  return { content, calls: native };
}

/**
 * Some endpoints ignore `stream: true` and answer with one JSON document.
 * Replay it in chunks so the transcript still fills in gradually.
 */
async function readWhole(
  res: Response,
  onDelta: (delta: Delta) => void,
): Promise<{ content: string; calls: ToolCall[] }> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all — treat whatever came back as the assistant's words.
    return { content: text, calls: [] };
  }

  const choices = (parsed as { choices?: Array<{ message?: MessageShape }> }).choices;
  const message = choices?.[0]?.message;
  const content = asText(message?.content);

  if (content.length > 0) {
    for (let i = 0; i < content.length; i += REPLAY_CHUNK) {
      onDelta({ content: content.slice(i, i + REPLAY_CHUNK) });
      if (i + REPLAY_CHUNK < content.length) await pause(REPLAY_DELAY_MS);
    }
  }

  return { content, calls: toNativeCalls(message?.tool_calls) };
}

async function recoverFromError(res: Response): Promise<AssistantTurn> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`provider HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const error = (parsed as { error?: { message?: string; code?: string; failed_generation?: string } }).error;

  // Groq/Llama shape: the intended call lives in failed_generation.
  if (error?.code === "tool_use_failed" && typeof error.failed_generation === "string") {
    const calls = extractToolCalls(error.failed_generation);
    if (calls.length > 0) {
      return { content: "", toolCalls: calls, raw: error.failed_generation, recovered: true };
    }
  }

  throw new Error(`provider HTTP ${res.status}: ${error?.message ?? text.slice(0, 400)}`);
}

export function createOpenAIProvider(options: OpenAIProviderOptions): Provider {
  const endpoint = options.baseUrl;

  return {
    name: options.name,

    async chat(
      req: ChatRequest,
      onDelta: (delta: Delta) => void,
      signal?: AbortSignal,
    ): Promise<AssistantTurn> {
      const wantsTools = options.nativeTools && req.tools.length > 0;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(options.extraHeaders ?? {}),
      };
      // Pollinations and Ollama are keyless: sending `Bearer ` would be a lie.
      if (options.apiKey.length > 0) headers.Authorization = `Bearer ${options.apiKey}`;

      const res = await fetch(endpoint, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          tools: wantsTools ? req.tools : undefined,
          tool_choice: wantsTools ? "auto" : undefined,
          temperature: req.temperature ?? 0.2,
          stream: true,
        }),
      });

      if (!res.ok) return recoverFromError(res);

      const contentType = res.headers.get("content-type") ?? "";
      const streamed = contentType.includes("text/event-stream");
      const { content, calls } = streamed
        ? await readStreamed(res, onDelta)
        : await readWhole(res, onDelta);

      if (calls.length > 0) {
        return { content, toolCalls: calls, raw: content, recovered: false };
      }

      const salvaged = extractToolCalls(content);
      if (salvaged.length > 0) {
        return { content: stripFunctionTags(content), toolCalls: salvaged, raw: content, recovered: true };
      }

      return { content, toolCalls: [], raw: content, recovered: false };
    },
  };
}
