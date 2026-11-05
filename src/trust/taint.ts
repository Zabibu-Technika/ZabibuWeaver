// Trust boundaries — Weaver's answer to the lethal trifecta.
//
// OpenClaw's researchers reduced its exposure to three legs that only become fatal
// together: deep access to private local data, interaction with untrusted external
// content, and the ability to communicate outward. Any two are survivable. All three
// is an exfiltration machine. See SAFETY.md for the full write-up and the CVEs.
//
// The architectural finding that shaped this file is the one the Cloud Security
// Alliance drew from OpenAI's Lockdown Mode announcement in June 2026:
//
//   The long-term defense posture is architectural, not behavioral... the language
//   model cannot reliably distinguish operator instructions from content it is
//   processing, and defense must therefore be located OUTSIDE the model.
//
// So nothing here asks the model whether it thinks it was manipulated. It cannot know.
// This module labels content by where it came from at the moment it entered, and
// refuses to let untrusted content flow into an outward or irreversible action without
// a human saying so — every time.
//
// The consequence of that decision is stated plainly in `assess`: value-level taint is
// a filter, not the guarantee, because the model paraphrases on every step and the
// external string rarely survives verbatim. Context-level taint is the guarantee. It is
// coarser and it costs extra confirmation clicks. That trade is deliberate: the cost of
// being conservative is a click, and the cost of being permissive is a credential.
import { isHighRisk } from "../core/types.ts";
import type { Capability, Provenance, ToolDef } from "../core/types.ts";

/** A chunk of content the agent has taken in, labelled at the moment it entered. */
export interface Ingest {
  provenance: Provenance;
  /** Where exactly it came from: "web:example.com", "email:alice@x", "file:notes.txt". */
  source: string;
  text: string;
}

/**
 * What the agent has ingested this turn.
 *
 * Turn-scoped on purpose. Trust is not a permanent property of a session — content
 * read last week should not silently grant consent to send something today, which is
 * how persistent memory poisoning (Radware's *ZombieAgent*) survives.
 */
export interface TrustState {
  ingested: Ingest[];
}

export function newTrustState(): TrustState {
  return { ingested: [] };
}

/**
 * Record what a tool returned, labelled at the moment it entered.
 *
 * The eviction order here is a security decision, not a detail. A naive ring buffer
 * would drop the oldest entry, and the oldest entry is very often the web page read at
 * the start of the turn — the one item whose loss erases all evidence that untrusted
 * content ever entered. Silently forgetting that would be the bug this module exists to
 * prevent, so the bug must not live here instead. We therefore evict the *least risky*
 * item first.
 */
export function recordIngest(state: TrustState, ingest: Ingest): void {
  if (state.ingested.length >= 200) {
    const evictable = state.ingested.findIndex((item) => item.provenance !== "external");
    state.ingested.splice(evictable === -1 ? 0 : evictable, 1);
  }
  state.ingested.push(ingest);
}

/** True when anything untrusted has entered the conversation this turn. */
export function hasExternal(state: TrustState): boolean {
  return state.ingested.some((ingest) => ingest.provenance === "external");
}

/** Where the untrusted content came from, for the consent prompt. */
export function externalSources(state: TrustState): string[] {
  const seen = new Set<string>();
  for (const ingest of state.ingested) {
    if (ingest.provenance === "external") seen.add(ingest.source);
  }
  return [...seen].slice(0, 5);
}

/**
 * The capability of a tool.
 *
 * Every tool in the registry **declares** this; inference is the fallback for tools
 * constructed outside it, and it is deliberately not the path anything real takes.
 * That matters more than it looks: `mutating: false` says a tool changes nothing, but
 * says nothing about whether it SENDS anything, so inferring "harmless read" from it
 * would quietly classify a network-fetching tool as safe. `src/trust/taint.test.ts`
 * asserts that every registered tool declares its class, which is what actually holds
 * that line — the fallback is only here so a programmatic caller cannot crash.
 */
export function capabilityOf(tool: Pick<ToolDef, "name" | "mutating" | "capability">): Capability {
  if (tool.capability !== undefined) return tool.capability;
  return tool.mutating ? "local-write" : "read";
}

/**
 * Instruction-shaped text found inside untrusted content.
 *
 * These are DISCLOSED, not enforced — see `assess`. A false positive here costs a
 * warning line; a false negative costs nothing extra, because the consent rule does not
 * depend on detection. That asymmetry is why the patterns can be aggressive without
 * being dangerous.
 */
export interface InjectionSignal {
  /** Stable identifier, so tests and reports can refer to it. */
  pattern: string;
  excerpt: string;
}

interface Shape {
  pattern: string;
  re: RegExp;
}

const INSTRUCTION_SHAPES: Shape[] = [
  // The textbook case, in all its phrasings.
  { pattern: "override-instructions", re: /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,40}\b(?:previous|prior|above|earlier|original|all|any)\b[\s\S]{0,30}\b(?:instructions?|rules?|prompts?|guidelines?|directives?)\b/i },
  // Claiming a role it has no right to claim.
  { pattern: "role-claim", re: /\byou\s+are\s+(?:now|no\s+longer)\b|\bas\s+your\s+(?:system|assistant)\b|\bact\s+as\s+(?:an?\s+)?(?:system|administrator|root)\b/i },
  // The Varonis lesson: urgency is persuasion aimed at a human, and it worked on the agent.
  { pattern: "urgency", re: /\b(?:urgent|immediately|right\s+now|act\s+now|before\s+the\s+(?:deadline|meeting|end\s+of\s+day)|time.?sensitive)\b/i },
  // Concealment. An agent asked to hide its reasoning from the operator is being run
  // by someone other than the operator.
  { pattern: "concealment", re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention|reveal|show|mention\s+to)\b[\s\S]{0,20}\b(?:the\s+)?user\b/i },
  { pattern: "concealment", re: /\b(?:keep|stay|remain)\s+(?:this\s+)?(?:quiet|silent|secret)\b/i },
  // Probing for or exfiltrating the agent's own configuration.
  { pattern: "prompt-probe", re: /\bsystem\s*prompt\b|\binitial\s+instructions?\b|\byour\s+(?:rules|restrictions|guardrails)\b/i },
  // Protocol smuggling: trying to invoke the tool channel from inside content.
  { pattern: "tool-smuggling", re: /<\s*(?:function|system|instructions?|tool)\s*[=>]/i },
  // Network payloads dressed as text. This is the shape of CVE-2026-25253's input.
  { pattern: "shell-payload", re: /\b(?:curl|wget|fetch|invoke-webrequest|iwr)\b[\s\S]{0,40}https?:\/\//i },
  // Encoded blobs. Nothing benign puts 120 characters of base64 in a web page or an
  // email, and when it does, it is not something a personal agent should carry silently.
  { pattern: "encoded-blob", re: /[A-Za-z0-9+/]{160,}={0,2}/ },
  { pattern: "encoded-blob", re: /\b[0-9a-f]{200,}\b/i },
  // "Run this script / install this" aimed at an agent that can run scripts.
  { pattern: "executable-instruction", re: /\b(?:run|execute|install|download|chmod|pipe\s+to)\b[\s\S]{0,30}\b(?:this|the\s+following|below)\b[\s\S]{0,20}\b(?:script|command|binary|payload|file)\b/i },
];

/**
 * Commands that pull content *onto* the machine, so their output is untrusted.
 *
 * Package managers and git belong here as much as curl does. `npm install` is how a
 * stranger's code reaches the disk in the first place, and its output — warnings,
 * lifecycle scripts, postinstall chatter — is text nobody typed.
 */
const NETWORK_FETCH =
  /\b(?:curl|wget|invoke-webrequest|iwr|fetch)\b|(?:https?|wss?):\/\/|\b(?:npm|npx|pnpm|yarn|bun)\s+(?:install|add|i)\b|\bpip3?\s+install\b|\bgem\s+install\b|\bgit\s+(?:clone|pull|fetch)\b/i;

/**
 * Commands that move data *off* the machine — the exfiltration leg of the trifecta.
 *
 * Kept separate from NETWORK_FETCH because the two answer different questions. Anything
 * here can carry a secret out; `npm install` cannot, however untrusted its own output.
 * Genuinely ambiguous cases (`curl`, `wget`, a bare URL) appear in both: a GET brings
 * content in and a POST sends it out, and no static check can tell which, so both
 * directions are taken rather than guessing in the permissive one.
 *
 * `wss?://` is here because a test demanded it, which is the most useful kind of test.
 * CVE-2026-25253 was a *WebSocket* that OpenClaw opened without prompting and sent a
 * token along. An earlier version of this pattern matched `https://` and not `wss://`,
 * so the exact vulnerability this module was written to prevent slipped straight
 * through. Matching the scheme the attack actually used is not a detail.
 */
const OUTBOUND_COMMAND =
  /\b(?:curl|wget|fetch|httpie|nc|netcat|socat|ssh|scp|rsync|sftp|ftp|wscat|websocat)\b|(?:https?|wss?):\/\/|\bgit\s+push\b|\b(?:npm|npx|pnpm|yarn|bun)\s+publish\b|\bpip3?\s+(?:upload|publish)\b/i;

/**
 * What a tool's output must be labelled as, or null when it introduces nothing.
 *
 * Shell is the interesting case and the one worth being precise about. Its output can
 * come from the user's machine or from the internet, and no static declaration can
 * tell which. So we do not guess from the tool — we read the command. `curl https://…`
 * puts remote text into the model's context; `npm test` does not. Getting this wrong in
 * the permissive direction is exactly how an injected instruction walks in wearing a
 * lab coat, and getting it wrong in the strict direction trains the user to click
 * through consent prompts. Both failure modes are real, which is why the line is drawn
 * at commands that actually move text into context.
 *
 * Note what `local` has come to mean, because it is narrower than it looks: *the output
 * of a local process that did not fetch*. It is not "safe" and it is not "the user's" —
 * a test suite printing an assertion error is as attacker-influenced as any file on
 * disk. It is a deliberate residual risk, taken because labelling every command's output
 * untrusted would make the trust layer fire on every build and stop being read at all.
 * That trade is written down here rather than left to be discovered by someone who
 * wonders why shell output is exempt.
 */
export function provenanceOfOutput(
  tool: Pick<ToolDef, "name" | "mutating" | "ingest">,
  args: Record<string, unknown>,
): Provenance | null {
  if (tool.ingest !== undefined) return tool.ingest;
  if (!tool.mutating) return "local";
  if (tool.name === "run_shell" && NETWORK_FETCH.test(String(args.command ?? ""))) return "external";
  return null;
}

/**
 * Can this call move data off the machine?
 *
 * For an `egress` tool, always. For shell, only when the command itself reaches out —
 * and that asymmetry is what the whole design turns on. A tool's *paraphrased intent* is
 * unreadable, which is why context-level taint has to gate conservatively; a shell
 * command's reach is written in the argument, in front of us, every time. Reading it
 * instead of assuming is what lets the trust layer stay strict about exfiltration
 * without prompting on every `npm test`.
 */
export function reachesOutside(
  tool: Pick<ToolDef, "name" | "mutating" | "capability">,
  args: Record<string, unknown>,
): boolean {
  const capability = capabilityOf(tool);
  if (capability === "egress") return true;
  if (capability !== "unbounded") return false;
  return OUTBOUND_COMMAND.test(String(args.command ?? ""));
}

/** Scan untrusted content for instruction-shaped text. Pure; safe to call anywhere. */
export function findInjectionSignals(text: string): InjectionSignal[] {
  const out: InjectionSignal[] = [];
  const seen = new Set<string>();
  for (const shape of INSTRUCTION_SHAPES) {
    const match = shape.re.exec(text);
    if (match === null) continue;
    // One signal per shape, with a short excerpt so the human can judge it.
    const start = Math.max(0, match.index - 20);
    const excerpt = text.slice(start, match.index + match[0].length + 20).replace(/\s+/g, " ").trim();
    const key = `${shape.pattern}:${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pattern: shape.pattern, excerpt: excerpt.length > 140 ? `${excerpt.slice(0, 137)}…` : excerpt });
  }
  return out;
}

/**
 * Credential-shaped text in something about to leave the machine.
 *
 * Written from the real prefixes rather than from a generic "looks like a key" rule,
 * because the generic rule has a hole you can drive a Stripe key through: `sk_live_…`
 * contains an underscore where `sk-…` expects a hyphen, so a `sk-` pattern misses every
 * live key Stripe has ever issued. Broad enough to catch the common families, narrow
 * enough not to fire on prose.
 */
const CREDENTIAL_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk[-_][A-Za-z0-9][A-Za-z0-9_-]{16,}\b/, // OpenAI `sk-…`, `sk-proj-…`, Stripe `sk_live_…`
  /\brk[-_]live[-_][A-Za-z0-9]{16,}\b/, // Stripe restricted keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub: ghp_, gho_, ghu_, ghs_, ghr_
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // a JWT
  /(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

export function containsCredential(text: string): boolean {
  return CREDENTIAL_SHAPES.some((re) => re.test(text));
}

/**
 * Value-level taint: does this text carry a fragment of something untrusted verbatim?
 *
 * A filter, not the guarantee. It catches the direct copy — an agent that pastes a URL
 * or a block of page text straight into a tool call — and misses every paraphrase. The
 * guarantee is `hasExternal`, which fires regardless.
 */
export function tracesToExternal(text: string, state: TrustState): Ingest | null {
  for (const ingest of state.ingested) {
    if (ingest.provenance !== "external") continue;
    for (const line of ingest.text.split(/\r?\n/)) {
      const fragment = line.trim();
      // Short lines are too common to be evidence; "Loading…" appearing in an argument
      // proves nothing.
      if (fragment.length < 24) continue;
      if (text.includes(fragment)) return ingest;
    }
  }
  return null;
}

export type Verdict =
  | { action: "allow" }
  | {
      action: "confirm";
      reason: string;
      risks: string[];
      /**
       * False when consent must be given again next time. Untrusted influence is never
       * pre-authorisable: "always allow" is exactly the mistake CVE-2026-25253 made,
       * just by a different route.
       */
      rememberable: boolean;
    }
  | { action: "deny"; reason: string };

export interface Assessment {
  tool: Pick<ToolDef, "name" | "mutating" | "capability">;
  args: Record<string, unknown>;
  trust: TrustState;
}

/**
 * Decide whether a call may proceed.
 *
 * The rule, in one line: **a high-risk call influenced by untrusted content needs a
 * human, every time.** Everything else in this function is detail about what
 * "influenced" and "high-risk" mean.
 */
export function assess(assessment: Assessment): Verdict {
  const { tool, args, trust } = assessment;
  const capability = capabilityOf(tool);
  const serialized = safeStringify(args);
  const risks: string[] = [];

  const externalHere = hasExternal(trust);
  const verbatim = tracesToExternal(serialized, trust);

  if (verbatim !== null) {
    risks.push(`this argument contains text read from ${verbatim.source}`);
  }
  if (externalHere) {
    risks.push(`this turn has read untrusted content (${externalSources(trust).join(", ")})`);
  }

  const influenced = externalHere || verbatim !== null;

  /**
   * The trifecta rule, narrowed so that it survives contact with real use.
   *
   * Context-level: untrusted content is in this turn AND the call leaves the machine.
   * Value-level: untrusted text is copied verbatim into a high-risk call, which is
   * direct enough evidence to gate regardless of where the call goes.
   *
   * `destructive` is not gated here, and that is a decision rather than an omission.
   * Destruction is the permission gate's job and it already asks. The trust layer exists
   * for the trifecta, which is about data *leaving*, not about data being lost.
   *
   * Shell is the case that needed care, and the reason is worth stating because it is
   * the load-bearing asymmetry in this whole module. A tool's paraphrased intent is
   * unreadable — that is precisely why context-level taint has to gate conservatively.
   * A shell command's reach is not: it is written in the argument, in front of us, every
   * time. `npm test` cannot exfiltrate and `curl` can, and we can see which. So we read
   * the command instead of assuming, which is what lets this layer stay strict about
   * exfiltration without prompting on every build.
   *
   * The alternative is worth naming so nobody "simplifies" back to it. Anthropic
   * published that Claude Code users approve 93% of permission prompts in March 2026,
   * rising to 97% by August. A gate that fires constantly is not a cautious gate, it is
   * a signing ritual — and a 97% approval rate means the confirmation stopped being read
   * long before it stopped being shown.
   */
  const outside = reachesOutside(tool, args);

  if ((outside && influenced) || (verbatim !== null && isHighRisk(capability))) {
    if (capability === "unbounded") {
      risks.push("a shell command can read, destroy, and send, and no check can prove otherwise");
    }
    return {
      action: "confirm",
      reason: outside
        ? `${tool.name} can send data off this machine, and this turn has taken in content the user does not control`
        : `${tool.name} is ${capability}, and its arguments copy text read from untrusted content`,
      risks,
      // Never remembered. Consent that sticks is the vulnerability.
      rememberable: false,
    };
  }

  // Memory poisoning, per Radware's ZombieAgent: writing untrusted, instruction-shaped
  // content to a file is how an injection outlives the input that carried it.
  if (capability === "local-write" && externalHere) {
    const instructions = findInjectionSignals(serialized);
    if (instructions.length > 0) {
      risks.push(
        `the content being written contains ${instructions.map((signal) => signal.pattern).join(", ")}`,
      );
      return {
        action: "confirm",
        reason: `${tool.name} would persist untrusted content containing instruction-shaped text`,
        risks,
        rememberable: false,
      };
    }
  }

  // Outbound data should not carry credentials, even when the human is watching.
  // This is the Varonis phishing simulation: the agent granted access because the
  // request felt urgent, and the secrets went with it.
  if ((capability === "egress" || capability === "unbounded") && containsCredential(serialized)) {
    risks.push("this looks like it carries a credential");
    return {
      action: "confirm",
      reason: `${tool.name} appears to be sending credential-shaped data`,
      risks,
      rememberable: false,
    };
  }

  return { action: "allow" };
}

/** JSON with a size cap — the trust ledger should not stringify a 10MB page. */
function safeStringify(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  return text.length > 200_000 ? text.slice(0, 200_000) : text;
}

/** A one-line summary for the consent prompt, or null when there is nothing to say. */
export function describe(verdict: Verdict): string | null {
  if (verdict.action !== "confirm") return null;
  return verdict.risks.map((risk) => `  ! ${risk}`).join("\n");
}
