// Routing — pick a model for the work, and do not spend money you said you would not.
//
// Two failures motivate this. The first is cost: agentic runs burn 5-30x the tokens of a
// chat call, and the bill arrives after the work. The second is more local — on a prepaid
// data plan or a currency that moves, a dollar-denominated API budget is a promise the
// user cannot keep if the agent spends without a ceiling.
//
// So the budget guard is the load-bearing part. Model selection is a policy on top: use
// the cheapest model that can do the job, and escalate only when the task is genuinely
// complex and the budget allows it. "Dynamic routing" that silently upgrades to a strong
// model is just a spending problem with better marketing.
//
// This module is deliberately pure: no network, no clock, no hidden state. A budget you
// cannot reason about is a budget you cannot trust.

export type Tier = "cheap" | "standard" | "strong";

export interface ModelRef {
  /** "provider/model", for display and for the provider layer. */
  id: string;
  tier: Tier;
  /** Context window in tokens. */
  context: number;
  /** USD per million input tokens. */
  inputPerM: number;
  /** USD per million output tokens. */
  outputPerM: number;
}

export interface Spend {
  /** null means no ceiling was configured. It is not the same as unlimited-by-accident. */
  limitUsd: number | null;
  spentUsd: number;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** What one call to `model` costs, in USD. */
export function estimateCost(model: ModelRef, tokensIn: number, tokensOut: number): number {
  const input = Math.max(0, tokensIn) * (model.inputPerM / 1_000_000);
  const output = Math.max(0, tokensOut) * (model.outputPerM / 1_000_000);
  return round(input + output);
}

/** Remaining budget, or null when no ceiling was set. */
export function remaining(spend: Spend): number | null {
  if (spend.limitUsd === null) return null;
  return round(Math.max(0, spend.limitUsd - spend.spentUsd));
}

/** True when this call fits. With no ceiling configured, everything fits. */
export function canAfford(spend: Spend, estimateUsd: number): boolean {
  const left = remaining(spend);
  return left === null || estimateUsd <= left;
}

/** Record actual spend. The number is truthful even if it overshoots the ceiling. */
export function charge(spend: Spend, actualUsd: number): Spend {
  return { limitUsd: spend.limitUsd, spentUsd: round(spend.spentUsd + Math.max(0, actualUsd)) };
}

export interface ComplexityInput {
  /** The user's request, verbatim. */
  prompt: string;
  /** Tokens the conversation will occupy for the call. */
  contextTokens: number;
  /** Tool calls the previous turn needed, if known. */
  steps?: number;
}

/**
 * A deterministic complexity score in [0, 1].
 *
 * Deliberately not an LLM call: deciding which model to use by asking a model is how a
 * routing layer doubles the spend it was meant to control. These are cheap, inspectable
 * signals, and the score only has to be good enough to separate "rename a variable" from
 * "migrate the database".
 */
export function assessComplexity(input: ComplexityInput): number {
  let score = 0;

  const prompt = input.prompt.toLowerCase();
  const words = prompt.split(/\s+/).filter((word) => word.length > 0).length;
  score += Math.min(0.25, words / 400);

  const heavy = [
    "refactor",
    "migrate",
    "architecture",
    "rewrite",
    "redesign",
    "concurrency",
    "performance",
    "security",
    "database",
    "distributed",
    "benchmark",
    "test suite",
  ];
  const hits = heavy.filter((word) => prompt.includes(word)).length;
  score += Math.min(0.35, hits * 0.09);

  score += Math.min(0.25, input.contextTokens / 200_000);
  score += Math.min(0.15, (input.steps ?? 0) * 0.02);

  return Math.round(Math.min(1, score) * 100) / 100;
}

export interface ChooseInput {
  models: ModelRef[];
  complexity: number;
  contextTokens: number;
  spend: Spend;
  /** Output tokens to reserve when checking affordability. Defaults to 4000. */
  reserveOut?: number;
}

const TIER_RANK: Record<Tier, number> = { cheap: 0, standard: 1, strong: 2 };

/**
 * Choose a model, or null when nothing fits.
 *
 * Returns null rather than silently overspending. A caller that gets null should stop
 * and tell the human, which is a much better outcome than a surprise invoice.
 */
export function chooseModel(input: ChooseInput): ModelRef | null {
  const reserveOut = input.reserveOut ?? 4_000;

  // Headroom matters: a model that exactly fits the current context has no room for the
  // reply, and the request fails after you have paid to send it.
  const fits = input.models.filter((model) => model.context >= Math.ceil(input.contextTokens * 1.2));
  if (fits.length === 0) return null;

  const affordable = fits.filter((model) => canAfford(input.spend, estimateCost(model, input.contextTokens, reserveOut)));
  if (affordable.length === 0) return null;

  const left = remaining(input.spend);
  const tight = left !== null && input.spend.limitUsd !== null && left < input.spend.limitUsd * 0.1;

  let wanted: Tier;
  if (tight) wanted = "cheap";
  else if (input.complexity >= 0.7) wanted = "strong";
  else if (input.complexity >= 0.35) wanted = "standard";
  else wanted = "cheap";

  // Walk down from the wanted tier until something is available, then up if the wanted
  // tier is missing entirely. Cheaper-first is the safe direction when guessing.
  for (let rank = TIER_RANK[wanted]; rank >= 0; rank -= 1) {
    const tier = (Object.keys(TIER_RANK) as Tier[]).find((key) => TIER_RANK[key] === rank);
    const candidate = affordable.find((model) => model.tier === tier);
    if (candidate !== undefined) return candidate;
  }
  for (let rank = TIER_RANK[wanted] + 1; rank <= 2; rank += 1) {
    const tier = (Object.keys(TIER_RANK) as Tier[]).find((key) => TIER_RANK[key] === rank);
    const candidate = affordable.find((model) => model.tier === tier);
    if (candidate !== undefined) return candidate;
  }
  return null;
}
