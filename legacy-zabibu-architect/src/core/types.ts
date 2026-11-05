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

export interface ToolOutcome {
  ok: boolean;
  output: string;
}

export interface ToolContext {
  workspace: string;
  /**
   * Shell prefix a containment backend wants prepended, when the caller can only pass a
   * command *string*. Null or absent means no containment is available for this call —
   * which is an honest state, not a missing one, and the disclosure for it has already
   * been shown to the human before the tool runs.
   */
  sandboxPrefix?: string | null;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True when the tool can change the filesystem or run programs. */
  mutating: boolean;
  /**
   * What its output must be labelled as in the trust ledger. Declared rather than
   * inferred, because getting this wrong is the failure: a tool that fetches from the
   * network and is labelled `local` is how an injected instruction walks in wearing a
   * lab coat. Defaults to `local` for reads and nothing for writes.
   */
  ingest?: Provenance;
  /** Overrides the capability derived from `mutating`. Shell declares `unbounded`. */
  capability?: Capability;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

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

/**
 * Where a piece of content came from.
 *
 * This is the whole security model in one type. The distinction is not academic:
 * OpenClaw's documented failures (see SAFETY.md) all came from treating content the
 * user does not control as though it were content they did. The model cannot reliably
 * make this distinction itself, so the code makes it.
 */
export type Provenance =
  /** Typed by the human in this session. Trusted. */
  | "user"
  /** Read from the user's own machine at their direction. Semi-trusted. */
  | "local"
  /** The web, email, messages, a skill — not under their control. Untrusted. */
  | "external";

/**
 * What a tool is capable of, which is what decides whether it needs consent.
 * The ordering matters: `unbounded` is the worst, not a synonym for the others.
 */
export type Capability =
  /** Looks, does not change. */
  | "read"
  /** Changes local state. Reversible with effort. */
  | "local-write"
  /** Deletes or overwrites. Not reversible. */
  | "destructive"
  /** Sends data outward, off the machine. The leg that turns a leak into a breach. */
  | "egress"
  /** Can do all of the above and cannot be classified. Shell. */
  | "unbounded";

export const CAPABILITY_ORDER: Capability[] = ["read", "local-write", "destructive", "egress", "unbounded"];

/** True when a call of this class can carry data off the machine or destroy it. */
export function isHighRisk(capability: Capability): boolean {
  return capability !== "read" && capability !== "local-write";
}

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
