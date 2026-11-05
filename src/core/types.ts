// Shared vocabulary for the whole agent. Kept dependency-free and serialisable
// so sessions can be written to disk and providers can be swapped freely.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The tool contract lives in the shared core, so Arif Agent can declare tools without reaching
 * into this runtime. Re-exported here because every existing import says `./types.ts`,
 * and a rename that breaks 280 tests buys nothing a re-export does not.
 */
export type { Capability, Provenance, ToolContext, ToolDef, ToolOutcome } from "../../core/contracts/tool.ts";
export { CAPABILITY_ORDER, isHighRisk } from "../../core/contracts/tool.ts";

export interface Delta {
  content?: string;
}

export interface AssistantTurn {
  content: string;
  toolCalls: ToolCall[];
  /** Raw assistant text before any recovery, for diagnostics. */
  raw: string;
  /** True when tool calls were salvaged from malformed output rather than native tool calling. */
  recovered: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  temperature?: number;
}

export interface Provider {
  name: string;
  chat(req: ChatRequest, onDelta: (delta: Delta) => void, signal?: AbortSignal): Promise<AssistantTurn>;
}

export type PermissionMode = "auto" | "full" | "readonly";

export type ConfirmAnswer = "yes" | "no" | "always";

/** Asks the human before a mutating action. Injected so headless runs can auto-deny. */
export type Confirm = (question: string) => Promise<ConfirmAnswer>;

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export interface Finding {
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  filePath?: string;
}

export interface AnalysisResult {
  riskScore: number;
  grade: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  findings: Finding[];
}

export interface SectorImpact {
  level: number;
  count: number;
}
