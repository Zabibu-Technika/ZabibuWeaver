// The tool contract shared by every axis.
//
// This lives in `core/` rather than in the runtime because Arif is a sibling project, not
// a subdirectory: it inherits `core/` by copy and must still be able to declare tools
// without reaching into Weaver's `src/`. One definition, two products.
//
// Everything here is structural and dependency-free, so the file can be copied without
// dragging a runtime along.

/**
 * Where a piece of content came from.
 *
 * The distinction is not academic. Most agent breaches come from treating content the
 * user does not control as though it were content they did. The model cannot reliably
 * make that distinction itself, so the code makes it.
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

export interface ToolOutcome {
  ok: boolean;
  output: string;
}

export interface ToolContext {
  workspace: string;
  /**
   * Shell prefix a containment backend wants prepended, when the caller can only pass a
   * command *string*. Null or absent means no containment is available for this call.
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
   * lab coat.
   */
  ingest?: Provenance;
  /** Overrides the capability derived from `mutating`. Shell declares `unbounded`. */
  capability?: Capability;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}
