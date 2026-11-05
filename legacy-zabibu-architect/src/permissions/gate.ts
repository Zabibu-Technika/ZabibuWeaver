// The permission gate — Weaver's conscience at the point of action.
//
// Canary reviews the change *after* it is made. The gate is the other half: it
// makes the agent ask before it does something irreversible.
//
// It now carries two distinct duties, and keeping them apart is the point:
//
//   1. Asks before mutating anything (the original job).
//   2. Asks before untrusted content can leave the machine or destroy something
//      (see src/trust/taint.ts, and SAFETY.md for why).
//
// `--permission full` opts out of the first. It does NOT opt out of disclosing what
// the agent was handed — `Decision.notice` survives every mode. Telling the user what
// happened costs them nothing, and a product that hides manipulation behind a
// verbosity flag is OpenClaw with better manners.
import type { Confirm, PermissionMode, ToolDef } from "../core/types.ts";
import { assess, describe, newTrustState, type TrustState } from "../trust/taint.ts";

export interface GateOptions {
  mode: PermissionMode;
  confirm: Confirm;
  /** Tool names the user has already said "always" to, for this session. */
  alwaysAllow: Set<string>;
  /**
   * What the agent has ingested this turn. Omitted means "nothing untrusted", which
   * is the safe reading only because it is also the common one — a caller that forgets
   * to pass it gets a gate that asks about mutations but not about exfiltration.
   */
  trust?: TrustState;
}

export interface Decision {
  allowed: boolean;
  reason?: string;
  /**
   * Something worth telling the human even when the call is allowed. Survives
   * `--permission full`, because disclosure is information, not a speed bump.
   */
  notice?: string;
}

function preview(tool: ToolDef, input: Record<string, unknown>): string {
  switch (tool.name) {
    case "write_file": {
      const content = typeof input.content === "string" ? input.content : "";
      return `${String(input.path ?? "?")} (${Buffer.byteLength(content, "utf8")} bytes)`;
    }
    case "edit_file":
      return `${String(input.path ?? "?")}`;
    case "run_shell":
      return `${String(input.command ?? "?").slice(0, 160)}`;
    default:
      return JSON.stringify(input).slice(0, 160);
  }
}

export async function authorize(
  tool: ToolDef,
  input: Record<string, unknown>,
  gate: GateOptions,
): Promise<Decision> {
  const trust = gate.trust ?? newTrustState();
  const verdict = assess({ tool, args: input, trust });

  if (verdict.action === "deny") return { allowed: false, reason: verdict.reason };

  if (verdict.action === "confirm") {
    const risks = describe(verdict);
    const question = risks === null ? `${tool.name}  ${preview(tool, input)}` : `${tool.name}  ${preview(tool, input)}\n${risks}`;

    // Note the ordering: this asks even in `full` mode, and it never consults
    // `alwaysAllow` when the verdict says the consent cannot be remembered. Both are
    // deliberate. `full` opts out of asking about mutations; it does not opt out of
    // asking whether untrusted content may leave the machine, because that is the one
    // question no permission mode should be able to answer for you in advance.
    const answer = await gate.confirm(question);
    if (answer === "always" && verdict.rememberable) gate.alwaysAllow.add(tool.name);
    if (answer === "yes" || answer === "always") return { allowed: true, notice: risks ?? undefined };
    return { allowed: false, reason: "declined" };
  }

  // Past the trust check: only the ordinary mutation rules remain.
  if (gate.mode === "full") return { allowed: true };
  if (!tool.mutating) return { allowed: true };
  if (gate.mode === "readonly") return { allowed: false, reason: "read-only mode" };
  if (gate.alwaysAllow.has(tool.name)) return { allowed: true };

  const answer = await gate.confirm(`${tool.name}  ${preview(tool, input)}`);
  if (answer === "always") {
    gate.alwaysAllow.add(tool.name);
    return { allowed: true };
  }
  if (answer === "yes") return { allowed: true };
  return { allowed: false, reason: "declined" };
}
