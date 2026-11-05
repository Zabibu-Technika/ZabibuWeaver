// The agent loop: one user turn is a sequence of model calls and tool runs,
// ending when the model stops asking for tools.
import type { AssistantTurn, ChatMessage, Confirm, Provider, ToolCall, ToolDef, ToolSchema } from "./types.ts";
import type { WeaverConfig } from "../config.ts";
import { WEAVER_ROOT } from "../config.ts";
import { resolve } from "node:path";
import { systemPrompt } from "./prompt.ts";
import { authorize, type GateOptions } from "../permissions/gate.ts";
import { parseArguments } from "../providers/toolcalls.ts";
import { findTool, toSchemas } from "../tools/index.ts";
import { reviewWorkspace, type CanaryReport } from "../integrate/canary.ts";
import { ledgerFor, context as decisionContext, record as recordDecision } from "../../core/memory/decisions.ts";
import { detectChecks, runChecks, summarize as summarizeVerification, type VerificationReport } from "../../core/verification/index.ts";
import { writeReceipt, summarizeProof, type ProofStatus } from "../../core/verification/receipt.ts";
import { assessScope } from "../../core/safety/scope.ts";
import {
  findInjectionSignals,
  newTrustState,
  provenanceOfOutput,
  recordIngest,
  reachesOutside,
  type TrustState,
} from "../trust/taint.ts";
import { capture, captureWorkspace, storeFor, type Store } from "../safety/checkpoints.ts";
import { detect as detectSandbox, needsDisclosure, plan as planSandbox, type Capability } from "../safety/sandbox.ts";
import { compact, estimateSchemas, estimateTokens, shouldCompact } from "./compact.ts";

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "assistant"; content: string; recovered: boolean }
  | { type: "tool-call"; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; name: string; ok: boolean; output: string; ms: number }
  | { type: "tool-denied"; name: string; reason: string }
  | { type: "notice"; text: string }
  /** A checkpoint was taken, so the UI can offer undo without polling for it. */
  | { type: "checkpoint"; id: string; tool: string; label: string; files: number; skipped: number }
  /** Older turns were summarized away to make room. */
  | { type: "compacted"; before: number; after: number; removed: number; degraded: boolean }
  /** The project's own checks ran. `attempt` is 1 for the first, higher after a repair. */
  | { type: "verify"; ok: boolean; attempt: number; summary: string; checks: number; skipped: number }
  /** The turn's evidence receipt was written. `status` is derived from evidence, not self-report. */
  | { type: "proof"; status: ProofStatus; summary: string; path: string }
  | { type: "canary"; report: CanaryReport }
  | { type: "error"; message: string }
  | { type: "turn-end" };

export interface AgentDeps {
  config: WeaverConfig;
  provider: Provider;
  tools: ToolDef[];
  confirm: Confirm;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface AgentState {
  messages: ChatMessage[];
  alwaysAllow: Set<string>;
  /**
   * True when a tool mutated the workspace during *this turn*. Reset at the start of
   * each turn, because "the session edited something once" would otherwise make every
   * later read-only turn re-run the test suite and re-judge an unchanged diff.
   */
  mutated: boolean;
  /**
   * What the agent has ingested this turn. Turn-scoped, not session-scoped: trust
   * granted because of something read last week must not silently authorise sending
   * something today, which is how persistent memory poisoning survives.
   */
  trust: TrustState;
  /** Where checkpoints live. Set once the workspace is known; null until then. */
  checkpoints: Store | null;
  /**
   * What this machine can actually contain a command with. Detected once per session
   * because it touches the filesystem, and cached so a turn never pays for it twice.
   * `null` means not detected yet — never "detected as nothing", which is a different
   * and much louder state.
   */
  sandbox: Capability | null;
  /** Bumped at each user turn, so a checkpoint can name the turn it undoes. */
  turn: number;
  /**
   * Paths written or edited during this turn. Used to decide whether the checks that
   * judged the turn were themselves touched — the difference between evidence and a
   * confidence trick.
   */
  touched: string[];
}

export function newAgentState(messages: ChatMessage[] = []): AgentState {
  return {
    messages,
    alwaysAllow: new Set<string>(),
    mutated: false,
    trust: newTrustState(),
    checkpoints: null,
    sandbox: null,
    turn: 0,
    touched: [],
  };
}

/**
 * Take a checkpoint before an authorised mutation, and disclose any containment gap.
 *
 * The ordering inside is the design, not an accident. Checkpoint first, disclosure second:
 * if detection or planning throws, we have already captured the undo, which is the layer
 * that still helps when the fence is missing. Containment narrows what can *happen*; a
 * checkpoint narrows what *persists*. When the first is unavailable, the second has to be
 * the thing standing behind it — and it only works if it was taken before the call.
 *
 * Nothing here can approve anything. This runs after the gate has said yes, and its only
 * authority is to record, to report, and to hand a containment plan to the tool.
 *
 * Returns the shell prefix a containment backend wants, or null when none is available
 * for this call.
 */
async function prepareSafety(
  deps: AgentDeps,
  state: AgentState,
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<string | null> {
  const { emit } = deps;
  const workspace = deps.config.workspace;

  if (state.checkpoints === null) state.checkpoints = storeFor(workspace);

  if (tool.mutating) {
    const label = describeCall(tool, args);
    try {
      const checkpoint =
        tool.name === "run_shell"
          ? await captureWorkspace(state.checkpoints, workspace, { turn: state.turn, tool: tool.name, label })
          : await capture(state.checkpoints, workspace, {
              turn: state.turn,
              tool: tool.name,
              label,
              paths: pathsOf(args),
            });
      emit({
        type: "checkpoint",
        id: checkpoint.id,
        tool: tool.name,
        label,
        files: checkpoint.files.length,
        skipped: checkpoint.skipped.length,
      });
      // A sweep that declined files must not look like full coverage. Saying so here is
      // the difference between a user checking the change and assuming it is covered.
      if (checkpoint.skipped.length > 0) {
        emit({
          type: "notice",
          text:
            `Checkpoint ${checkpoint.id} could not cover ${checkpoint.skipped.length} file(s) ` +
            `(too large, over budget, or unreadable), so undo will not reach them.`,
        });
      }
    } catch (err) {
      // A checkpoint that failed must be louder than one that worked: it is the recovery
      // layer the disclosure below is about to point the user at.
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "notice",
        text: `No checkpoint was taken (${message}). This change cannot be undone from within Weaver.`,
      });
    }
  }

  if (tool.name !== "run_shell") return null;

  // Detected once per session: it touches the filesystem, and the answer cannot change
  // under us mid-session. Disclosed at the moment of detection, which makes it exactly
  // once — a per-command warning about an invariant property trains people to skip it.
  if (state.sandbox === null) {
    state.sandbox = await detectSandbox(workspace);
    if (needsDisclosure(state.sandbox)) {
      const plan = await planSandbox({ workspace, argv: [] }, state.sandbox);
      if (plan.disclosure !== null) emit({ type: "notice", text: plan.disclosure });
    }
  }

  const command = typeof args.command === "string" ? args.command : null;
  if (command === null) return null;

  // A command that will leave the machine gets no containment prefix even when one is
  // otherwise available — the prefix is a filesystem fence, and advertising a fence that
  // does not address the actual route out is worse than advertising none.
  if (reachesOutside(tool, args)) return null;

  const plan = await planSandbox({ workspace, argv: [command], network: false }, state.sandbox);
  return plan.prefix;
}

/** A short label for a checkpoint, derived from the arguments it covers. */
function describeCall(tool: ToolDef, args: Record<string, unknown>): string {
  if (tool.name === "run_shell") {
    const command = typeof args.command === "string" ? args.command : "";
    return command.length > 60 ? `${command.slice(0, 57)}...` : command;
  }
  return pathsOf(args).join(", ") || tool.name;
}

/** Which paths a tool call is expected to touch, for a precise checkpoint. */
function pathsOf(args: Record<string, unknown>): string[] {
  const path = args.path;
  return typeof path === "string" ? [path] : [];
}

async function runToolCall(
  deps: AgentDeps,
  state: AgentState,
  gate: GateOptions,
  call: ToolCall,
): Promise<void> {
  const { emit } = deps;
  const tool = findTool(deps.tools, call.function.name);

  if (tool === null) {
    const message = `error: unknown tool "${call.function.name}"`;
    emit({ type: "tool-result", name: call.function.name, ok: false, output: message, ms: 0 });
    state.messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: message });
    return;
  }

  let args: Record<string, unknown>;
  try {
    args = parseArguments(call.function.arguments);
  } catch (err) {
    const message = `error: ${err instanceof Error ? err.message : String(err)}`;
    emit({ type: "tool-result", name: tool.name, ok: false, output: message, ms: 0 });
    state.messages.push({ role: "tool", tool_call_id: call.id, name: tool.name, content: message });
    return;
  }

  emit({ type: "tool-call", name: tool.name, args });

  const decision = await authorize(tool, args, { ...gate, trust: state.trust });
  if (!decision.allowed) {
    const reason = decision.reason ?? "denied";
    emit({ type: "tool-denied", name: tool.name, reason });
    state.messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: tool.name,
      content: `error: permission denied (${reason})`,
    });
    return;
  }

  // Disclosure survives every permission mode. The user should know when the agent
  // was handed something that tried to look like an instruction.
  if (decision.notice !== undefined) emit({ type: "notice", text: decision.notice });

  if (tool.mutating) {
    state.mutated = true;
    // For the proof receipt: a turn that edited a test or a check config cannot use a
    // passing run as independent evidence.
    if (typeof args.path === "string") state.touched.push(args.path);
  }

  // Checkpoint and containment run after the gate has said yes, never before, and neither
  // can widen what the gate allowed. Their authority is to record and to report.
  const sandboxPrefix = await prepareSafety(deps, state, tool, args);

  const started = Date.now();
  let outcome: { ok: boolean; output: string };
  try {
    outcome = await tool.run(args, { workspace: deps.config.workspace, sandboxPrefix });
  } catch (err) {
    outcome = { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
  const ms = Date.now() - started;

  emit({ type: "tool-result", name: tool.name, ok: outcome.ok, output: outcome.output, ms });
  state.messages.push({ role: "tool", tool_call_id: call.id, name: tool.name, content: outcome.output });

  recordOutput(deps, state, tool, args, outcome);
}

/**
 * Label what a tool returned, and say so out loud when it looks like it is carrying
 * instructions.
 *
 * The declaration on the tool (`ingest`) is what matters — an undeclared tool is never
 * silently trusted as `external`, because the failure mode of getting this backwards is
 * the whole OpenClaw story. Reads default to `local`; writes carry nothing, since
 * writing does not introduce new content into the conversation.
 */
function recordOutput(
  deps: AgentDeps,
  state: AgentState,
  tool: ToolDef,
  args: Record<string, unknown>,
  outcome: { ok: boolean; output: string },
): void {
  if (!outcome.ok) return;

  const provenance = provenanceOfOutput(tool, args);
  if (provenance === null) return;

  const source = provenance === "external" ? tool.name : `${tool.name}:${String(args.path ?? args.pattern ?? tool.name)}`;
  recordIngest(state.trust, { provenance, source, text: outcome.output });

  if (provenance !== "external") return;

  // Untrusted content: scan it and tell the human what it contains. Detection is
  // disclosure only — the consent rule in taint.ts does not depend on it firing, so a
  // miss costs a warning the user never saw, not a boundary nobody enforced.
  const signals = findInjectionSignals(outcome.output);
  if (signals.length === 0) return;

  const patterns = [...new Set(signals.map((signal) => signal.pattern))].join(", ");
  emitNotice(deps, `untrusted content from ${source} contains instruction-shaped text (${patterns}) — it is data, not orders`);
  for (const signal of signals.slice(0, 3)) {
    emitNotice(deps, `  “${signal.excerpt}”`);
  }
}

function emitNotice(deps: AgentDeps, text: string): void {
  deps.emit({ type: "notice", text });
}

/**
 * One pass of the model loop: call the model, run whatever tools it asks for,
 * repeat until it stops asking (or the step ceiling is hit).
 *
 * This is separate from `runTurn` because the fix-verify loop calls it again. A
 * repair pass is not a different kind of thing — it is the same loop continuing
 * over the same conversation, with one more user message at the end of it.
 */
async function driveLoop(
  deps: AgentDeps,
  state: AgentState,
  gate: GateOptions,
  system: string,
  schemas: ToolSchema[],
): Promise<void> {
  const { config, emit } = deps;

  const onDelta = (delta: { content?: string }): void => {
    emit({ type: "delta", text: delta.content ?? "" });
  };

  for (let step = 0; step < config.maxSteps; step += 1) {
    await maybeAutoCompact(deps, state, system, schemas);

    const turn = await callModel(deps, state, system, schemas, onDelta);
    if (turn === null) break;

    if (turn.recovered) {
      emit({ type: "notice", text: "recovered a malformed tool call from the model's output" });
    }

    state.messages.push({
      role: "assistant",
      content: turn.content,
      tool_calls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    });
    emit({ type: "assistant", content: turn.content, recovered: turn.recovered });

    if (turn.toolCalls.length === 0) break;

    for (const call of turn.toolCalls) {
      await runToolCall(deps, state, gate, call);
    }
  }
}

/**
 * The context settings for this session, from config.
 */
function compactSettings(deps: AgentDeps): { contextWindow: number; keep: number; buffer: number } {
  return {
    contextWindow: deps.config.contextWindow,
    keep: deps.config.compactKeep,
    buffer: deps.config.compactBuffer,
  };
}

/**
 * Compact when the conversation, plus the fixed cost of the system prompt and the tool
 * schemas, has reached the threshold. Mutates `state.messages` in place of the head.
 */
async function maybeAutoCompact(
  deps: AgentDeps,
  state: AgentState,
  system: string,
  schemas: ToolSchema[],
): Promise<void> {
  if (!deps.config.compact) return;
  const settings = compactSettings(deps);
  const fixed = estimateTokens(system) + estimateSchemas(schemas);
  if (!shouldCompact(state.messages, settings, fixed)) return;
  await runCompact(deps, state, system, schemas);
}

/**
 * Compact now, for real, and report it. Returns whether anything was actually compacted.
 *
 * A compaction that finds no safe split is not an error — it means the conversation is
 * one giant turn, and there is nothing to summarize away without deleting the task.
 */
async function runCompact(
  deps: AgentDeps,
  state: AgentState,
  system: string,
  schemas: ToolSchema[],
): Promise<boolean> {
  const settings = compactSettings(deps);
  const result = await compact(state.messages, deps.provider, settings, {
    model: deps.config.model,
    signal: deps.signal,
  });
  if (result === null) return false;

  state.messages = result.messages;
  deps.emit({
    type: "compacted",
    before: result.before,
    after: result.after,
    removed: result.removed,
    degraded: result.degraded,
  });
  if (result.degraded) {
    deps.emit({ type: "notice", text: "compaction degraded — earlier turns were dropped, not summarized" });
  }
  return true;
}

/**
 * Whether an error message means "this request is longer than the model accepts".
 *
 * Providers phrase it many ways ("maximum context length exceeded", "input tokens too
 * long", "context_length_exceeded"), so this is a broad match. A false positive only
 * costs one extra attempt, which is far cheaper than a false negative leaving a
 * resumable session stranded.
 */
function isContextOverflow(message: string): boolean {
  return /context.{0,24}(length|window|limit|too long|exceed)|maximum.{0,24}(context|tokens)|tokens? .{0,16}too long|input.{0,16}too long/i.test(
    message,
  );
}

/**
 * Call the model once, compacting and retrying a single time when the provider rejects
 * the conversation as too long.
 *
 * The retry is the difference between "the session died at 90% of the work" and "the
 * session summarized the early part and finished". It is bounded to one retry so a
 * genuinely broken request cannot loop.
 */
async function callModel(
  deps: AgentDeps,
  state: AgentState,
  system: string,
  schemas: ToolSchema[],
  onDelta: (delta: { content?: string }) => void,
): Promise<AssistantTurn | null> {
  const { config, provider, emit } = deps;
  let attempted = false;
  for (;;) {
    try {
      return await provider.chat(
        {
          model: config.model,
          messages: [{ role: "system", content: system }, ...state.messages],
          tools: schemas,
          temperature: config.temperature,
        },
        onDelta,
        deps.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!attempted && isContextOverflow(message)) {
        attempted = true;
        emit({ type: "notice", text: "the provider rejected the conversation as too long — compacting and retrying once" });
        if (await runCompact(deps, state, system, schemas)) continue;
      }
      emit({ type: "error", message });
      return null;
    }
  }
}

/**
 * What the model is told when the judge blocks its change.
 *
 * Written for a model, not for a person, and it says the three things that are
 * easy to leave out and dangerous to omit: that the model cannot approve its own
 * work, that satisfying the check by removing it is not a fix, and that a false
 * positive should be raised rather than quietly routed around. A repair loop that
 * did not spell those out would be a machine for teaching an agent to launder a
 * finding instead of answering it.
 */
function repairBrief(report: CanaryReport, pass: number, budget: number): string {
  const critical = report.findings.filter((finding) => finding.severity === "critical");
  const listed = critical
    .slice(0, 10)
    .map((finding) => {
      const where = finding.filePath === undefined ? "" : ` — ${finding.filePath}`;
      return `- [${finding.severity}] ${finding.title} (${finding.category})${where}\n    ${finding.detail}`;
    })
    .join("\n");
  const overflow = critical.length > 10 ? `\n(+${critical.length - 10} more, truncated)` : "";

  return [
    `The change you just made was judged by an independent, deterministic reviewer`,
    `(analysis ${report.analysisId}) and it is BLOCKED. Verdict: ${report.verdict}.`,
    ``,
    `Critical findings:`,
    `${listed}${overflow}`,
    ``,
    `Fix the cause in the files — not the check. Specifically:`,
    `- Do NOT attempt to approve, sign, or record this change. You cannot. The approval`,
    `  ledger is written by the Canary CLI, and an agent that signs its own permission`,
    `  slip is not being governed, it is being asked nicely.`,
    `- Do NOT delete, disable, or neuter whatever produced the finding just to quieten`,
    `  the report. That is not a fix, and the next judgement will notice.`,
    `- If a finding is a false positive, say so plainly and leave the code alone. The`,
    `  change stays BLOCKED and the human decides, not you.`,
    ``,
    `Repair pass ${pass} of ${budget}. When you are done, stop and say what you changed;`,
    `the gate re-runs automatically. If you cannot fix it, say that instead.`,
  ].join("\n");
}

/** Run the judge once. Anything unexpected is loud, and a re-judge that fails stays blocked. */
async function reviewOnce(deps: AgentDeps, previous: CanaryReport | null): Promise<CanaryReport | null> {
  const { emit } = deps;
  try {
    return await reviewWorkspace(deps.config);
  } catch (err) {
    // Fail closed. `reviewWorkspace` already returns a blocked report for every
    // failure mode we can anticipate, so reaching here means something we did not
    // predict went wrong. If that happens on a RE-judge, the verdict that stands is
    // the blocked one we already have — never the clean state it would fall back to.
    const message = err instanceof Error ? err.message : String(err);
    if (previous !== null) return previous;
    emit({ type: "error", message: `the sign-off could not run — treat this turn as unreviewed (${message})` });
    return null;
  }
}

/**
 * The sign-off, with the fix-verify loop around it (Greptile's `/greploop` idea).
 *
 * A blocked verdict is information, and the model that caused the block is better
 * placed to act on it than the human reading it. So when the judge blocks, the
 * findings are handed back to the model for one bounded repair pass and the judge
 * runs again.
 *
 * What this does NOT weaken: nothing here can approve anything. The gate is the
 * same `reviewWorkspace` call against the new diff, and only the ledger approves.
 * The loop changes who does the copy-pasting, not who decides.
 *
 * Three deliberate limits:
 *   - A failing judge is never handed to the model. An engine that will not load
 *     is not a coding problem, and inviting a repair would mean rewriting files to
 *     satisfy a gate that never ran.
 *   - It is bounded by `config.canaryRepair` (default 1, hard-capped at 5).
 *   - It stops early when the analysis id is unchanged, because the same diff
 *     produces the same verdict and asking twice teaches nothing.
 */
async function signOff(
  deps: AgentDeps,
  state: AgentState,
  gate: GateOptions,
  system: string,
  schemas: ToolSchema[],
): Promise<CanaryReport | null> {
  const { config, emit } = deps;
  if (!state.mutated || config.canary === "off") return null;

  let report = await reviewOnce(deps, null);
  if (report !== null) emit({ type: "canary", report });

  for (let pass = 1; pass <= config.canaryRepair; pass += 1) {
    if (report === null || !report.blocked) break;
    if (report.judgeError !== undefined) break;

    const before = report.analysisId;
    emit({ type: "notice", text: `sign-off BLOCKED — handing the findings back for repair pass ${pass}/${config.canaryRepair}` });
    state.messages.push({ role: "user", content: repairBrief(report, pass, config.canaryRepair) });

    await driveLoop(deps, state, gate, system, schemas);

    report = await reviewOnce(deps, report);
    if (report !== null) emit({ type: "canary", report });

    if (report === null || !report.blocked) {
      emit({ type: "notice", text: `the sign-off cleared after ${pass} repair pass${pass === 1 ? "" : "es"}` });
      break;
    }
    if (report.analysisId === before) {
      emit({ type: "notice", text: "the repair pass changed nothing, so the verdict stands" });
      break;
    }
    if (pass === config.canaryRepair) {
      emit({ type: "notice", text: `the sign-off is still BLOCKED after ${pass} repair pass${pass === 1 ? "" : "es"} — not signed off` });
    }
  }

  return report;
}

/** What the model is told when the project's own checks fail. */
function verificationBrief(report: VerificationReport, pass: number, budget: number): string {
  return [
    "The project's own checks failed. That is the definition of done here, not your",
    "description of the change.",
    "",
    summarizeVerification(report),
    "",
    "Rules:",
    "- Fix the cause in the code. Do NOT delete, skip, or weaken a check to make it pass.",
    "- Do not claim success without a passing run; verification re-runs automatically.",
    "- If a check is broken for reasons unrelated to this change, say so and stop.",
    "",
    `Verification repair pass ${pass} of ${budget}.`,
  ].join("\n");
}

/**
 * Proof of state: a mutating turn is not finished until the project's checks pass.
 *
 * This runs before the sign-off, so the judge sees the final diff rather than the
 * intermediate one. It is bounded by the same repair budget as the Canary loop, and it
 * is skipped for Weaver's own workspace because running the engine's suite from inside
 * an engine turn is recursion, not verification.
 */
async function verifyAndRepair(
  deps: AgentDeps,
  state: AgentState,
  gate: GateOptions,
  system: string,
  schemas: ToolSchema[],
): Promise<VerificationReport | null> {
  const { config, emit } = deps;
  if (!config.verify || !state.mutated) return null;

  // Windows paths are case-insensitive, and the shell may hand us a different casing
  // than `import.meta.url` does. Comparing resolved strings without folding the case
  // would let the engine verify itself and recurse.
  const workspace = resolve(config.workspace);
  const self = resolve(WEAVER_ROOT);
  const sameWorkspace =
    process.platform === "win32" ? workspace.toLowerCase() === self.toLowerCase() : workspace === self;
  if (sameWorkspace) {
    emit({
      type: "notice",
      text: "verification skipped: this workspace is Weaver itself, so its own suite cannot run from inside a turn",
    });
    return null;
  }

  const checks = await detectChecks(config.workspace);
  if (checks.length === 0) {
    emit({
      type: "notice",
      text: "no verification checks were detected — this change is unproven, not proven",
    });
    return { ok: false, checks: [], skipped: [], ms: 0 };
  }

  let report = await runChecks(config.workspace, checks);
  emit({
    type: "verify",
    ok: report.ok,
    attempt: 1,
    summary: summarizeVerification(report),
    checks: report.checks.length,
    skipped: report.skipped.length,
  });

  for (let pass = 1; !report.ok && pass <= config.canaryRepair; pass += 1) {
    emit({ type: "notice", text: `verification failed — handing it back for repair pass ${pass}/${config.canaryRepair}` });
    state.messages.push({ role: "user", content: verificationBrief(report, pass, config.canaryRepair) });
    await driveLoop(deps, state, gate, system, schemas);
    report = await runChecks(config.workspace, checks);
    emit({
      type: "verify",
      ok: report.ok,
      attempt: pass + 1,
      summary: summarizeVerification(report),
      checks: report.checks.length,
      skipped: report.skipped.length,
    });
  }

  if (!report.ok) {
    emit({
      type: "notice",
      text: "verification is still failing — this change is not verified, whatever the model says",
    });
  }

  return report;
}

/** Record a decision without letting a ledger failure break the turn. */
async function remember(deps: AgentDeps, input: Parameters<typeof recordDecision>[1]): Promise<void> {
  try {
    await recordDecision(ledgerFor(deps.config.workspace), input);
  } catch (err) {
    deps.emit({ type: "notice", text: `could not record a decision: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export async function runTurn(deps: AgentDeps, state: AgentState, userInput: string): Promise<void> {
  const { config, tools, confirm, emit } = deps;

  state.messages.push({ role: "user", content: userInput });
  state.mutated = false;
  state.touched = [];

  // Trust is turn-scoped, so it resets here — and the human's own words are the only
  // thing recorded as trusted before the turn begins.
  state.trust = newTrustState();
  recordIngest(state.trust, { provenance: "user", source: "the human", text: userInput });

  // Surface a trap before acting on it. This is friction, not a veto: the agent says
  // what it noticed and what it would like to know, and the human decides.
  const scope = assessScope({ request: userInput });
  if (scope.level !== "ok") {
    emit({
      type: "notice",
      text: `scope check: ${scope.level} (${Math.round(scope.confidence * 100)}% confidence) — ${scope.reasons.join("; ")}`,
    });
    if (scope.question !== null) emit({ type: "notice", text: `  ${scope.question}` });
  }

  const schemas = toSchemas(tools);
  const gate: GateOptions = { mode: config.permission, confirm, alwaysAllow: state.alwaysAllow };
  // Endpoints that do not honour `tools` need the protocol spelled out instead.
  const base = systemPrompt(config, schemas);

  // Decisions are memory that survives compaction. They are injected bounded, because
  // an unbounded memory is just a context window with a longer bill.
  const remembered = await decisionContext(ledgerFor(config.workspace), { limit: 10, maxChars: 1_500 });
  const system =
    remembered.length === 0
      ? base
      : `${base}\n\nDecisions already made (do not re-litigate these without saying what changed):\n${remembered}`;

  await driveLoop(deps, state, gate, system, schemas);
  const verification = await verifyAndRepair(deps, state, gate, system, schemas);
  const report = await signOff(deps, state, gate, system, schemas);

  if (report !== null && report.blocked) {
    const rationale =
      report.findings
        .slice(0, 3)
        .map((finding) => `${finding.severity}: ${finding.title}`)
        .join("; ") ||
      report.judgeError ||
      report.verdict ||
      "blocked";
    await remember(deps, {
      kind: "rejection",
      title: `Canary blocked ${report.analysisId}`,
      rationale,
      tags: ["canary", "blocked"],
      source: "judge",
    });
  }

  // The receipt is the durable half of the claim. A turn that changed something gets
  // one, even when the answer is "unproven" — especially then.
  if (state.mutated) {
    try {
      const written = await writeReceipt({
        workspace: config.workspace,
        report: verification,
        touched: state.touched,
        analysisId: report?.analysisId,
      });
      emit({
        type: "proof",
        status: written.receipt.status,
        summary: summarizeProof(written.receipt),
        path: written.markdownPath,
      });
    } catch (err) {
      emit({
        type: "notice",
        text: `could not write the proof receipt: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  emit({ type: "turn-end" });
}
