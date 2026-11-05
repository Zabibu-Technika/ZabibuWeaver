// Scope and friction — saying "that request has a trap in it" before acting.
//
// The failure this addresses is not disobedience. It is an agent that is *too agreeable*:
// it bundles three unrelated objectives, adds a dependency nobody asked for, or deletes
// something whose name did not sound dangerous, because the user was in a hurry and the
// request was grammatically an instruction.
//
// This is a deterministic read of the request, not a model's opinion of it. Asking a
// model whether a request is risky makes the risk assessment as unreliable as the
// request, and costs a request to do it. The signals here are crude, inspectable, and
// cheap — which is exactly what a friction layer should be.
//
// WHAT IT IS NOT
//
// This does not veto. `stop` means "surface this and ask", not "refuse silently". The
// agent's job is to make the risk legible; the human's job is to decide. A guardrail
// that overrides people is a different product, and a worse one.
export type ScopeLevel = "ok" | "caution" | "stop";

export interface ScopeAssessment {
  level: ScopeLevel;
  /** 0..1. Higher when more independent signals agree. */
  confidence: number;
  /** One line per signal, in plain language. */
  reasons: string[];
  /** The question to put to the human, when one is worth asking. */
  question: string | null;
}

export interface ScopeInput {
  request: string;
}

const DESTRUCTIVE = /\b(delete|remove|drop|wipe|erase|truncate|destroy|reset|overwrite|purge)\b/i;
const GLOBAL_SCOPE =
  /\b(all|everything|every|entire|whole|repo|repository|database|db|table|tables|branch|history|production|prod|customers?|users?)\b/i;
const CATASTROPHIC =
  /(rm\s+-rf\s+[\\/]|drop\s+(database|table)|truncate\s+table|reset\s+--hard|push\s+--force|format\s+c:)/i;
const CREDENTIAL = /\b(api[\s_-]?key|secret|password|passwd|token|credential|private[\s_-]?key|\.env)\b/i;
/**
 * A verb that actually moves data outward.
 *
 * Deliberately narrow. "message" and "post" alone appear in ordinary coding requests
 * ("fix the error message", "add a blog post page"), and a friction layer that stops on
 * those is one the user turns off — after which it protects nothing. This is used only
 * for the credential-exfiltration rule, where a false positive costs a question and a
 * miss costs a leak.
 */
const SEND_VERB = /\b(send|email|e-mail|upload|share|tweet|dm|publish|forward|transmit)\b|\bpost\b/i;
const IRREVERSIBLE_EXTERNAL =
  /\b(deploy|release|publish|send|email|e-mail|charge|pay|transfer|tweet|migrate)\b|post\s+to\b|\bcrm\s+sync\b/i;
const DEPENDENCY = /\b(npm\s+(i|install)|pnpm\s+(add|install)|yarn\s+add|pip\s+install|install|add\s+(a\s+)?(package|dependency|library))\b/i;
const SCOPE_CREEP = /\b(also|while\s+you(?:'re|\s+are)\s+at\s+it|and\s+then|plus|as\s+well|additionally)\b/i;
const BIG_REWRITE = /\b(refactor|rewrite|redesign|restructure)\b.*\b(everything|whole|entire|all)\b/i;
const PRODUCTION = /\b(production|prod|live)\b/i;

const MAX_REASONS = 6;

/**
 * Read the request for the handful of shapes that deserve a question.
 *
 * Order matters: `stop` wins over `caution`, and both are capped so a long request
 * cannot accumulate a dramatic score out of ordinary words.
 */
export function assessScope(input: ScopeInput): ScopeAssessment {
  const request = input.request.trim();
  const reasons: string[] = [];
  let stop = false;

  if (request.length === 0) {
    return { level: "ok", confidence: 0, reasons: [], question: null };
  }

  if (CATASTROPHIC.test(request)) {
    stop = true;
    reasons.push("this is a destructive command whose usual effect is unrecoverable");
  }

  if (DESTRUCTIVE.test(request) && GLOBAL_SCOPE.test(request)) {
    // "delete the unused import" is fine; "delete all the users" is not. The global
    // scope word is what separates a tidy-up from a catastrophe.
    stop = true;
    reasons.push("a destructive verb is aimed at a whole scope, not a named item");
  }

  if (CREDENTIAL.test(request) && SEND_VERB.test(request)) {
    stop = true;
    reasons.push("credentials and an outbound action appear in the same request");
  }

  if (IRREVERSIBLE_EXTERNAL.test(request)) {
    reasons.push("this reaches outside the machine, where undo is not a file operation");
  }

  if (DEPENDENCY.test(request)) {
    reasons.push("this adds a dependency, which is supply chain and a long-term maintenance cost");
  }

  if (SCOPE_CREEP.test(request)) {
    reasons.push("the request bundles more than one objective");
  }

  if (BIG_REWRITE.test(request)) {
    reasons.push("this is a broad rewrite rather than a focused change");
  }

  if (PRODUCTION.test(request) && !IRREVERSIBLE_EXTERNAL.test(request)) {
    reasons.push("the request names production, which usually raises the cost of a mistake");
  }

  const unique = [...new Set(reasons)].slice(0, MAX_REASONS);
  const level: ScopeLevel = stop ? "stop" : unique.length > 0 ? "caution" : "ok";
  const confidence = unique.length === 0 ? 0 : Math.min(0.95, 0.55 + unique.length * 0.12);

  return {
    level,
    confidence: Math.round(confidence * 100) / 100,
    reasons: unique,
    question: unique.length === 0 ? null : chooseQuestion(unique, request),
  };
}

function chooseQuestion(reasons: string[], request: string): string {
  const text = reasons.join(" ");
  if (/credentials/.test(text)) {
    return "Credentials and an outbound action are both present. Which specific value is being sent, to whom, and was that intended?";
  }
  if (/destructive/.test(text) || /unrecoverable/.test(text)) {
    return "This could destroy data that a rollback cannot restore. What exactly should be affected, and is there a backup?";
  }
  if (/dependency/.test(text)) {
    return "This adds a dependency. Is it acceptable to expand the supply chain, or can the same result be reached with what is already here?";
  }
  if (/outside the machine/.test(text)) {
    return "This leaves the machine. Is it meant to happen now, in this environment, and is the compensation something you can actually do?";
  }
  if (/bundles/.test(text)) {
    return "This request contains more than one objective. Which one should be done first, so each can be verified on its own?";
  }
  return `Before I start: ${request.length > 80 ? "the request is broad." : ""} What does success look like, specifically?`;
}
