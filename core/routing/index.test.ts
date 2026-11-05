// Routing and budget.
//
// The property that matters most is not "the right model was picked". It is that a
// budget that has been spent refuses the next call instead of silently borrowing.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assessComplexity,
  canAfford,
  charge,
  chooseModel,
  estimateCost,
  remaining,
  type ModelRef,
  type Spend,
} from "./index.ts";

const CHEAP: ModelRef = { id: "groq/llama-small", tier: "cheap", context: 32_000, inputPerM: 0.05, outputPerM: 0.08 };
const STANDARD: ModelRef = { id: "groq/gpt-oss-120b", tier: "standard", context: 131_072, inputPerM: 0.15, outputPerM: 0.6 };
const STRONG: ModelRef = { id: "openai/gpt-5", tier: "strong", context: 128_000, inputPerM: 1.25, outputPerM: 10 };
const MODELS = [CHEAP, STANDARD, STRONG];

test("cost is per-million tokens, in both directions", () => {
  const cost = estimateCost(STANDARD, 1_000_000, 0);
  assert.equal(cost, 0.15);
  assert.equal(estimateCost(STANDARD, 0, 1_000_000), 0.6);
  assert.equal(estimateCost(STANDARD, 1_000, 1_000), 0.00075);
});

test("no ceiling means everything fits, and a ceiling means it does not once spent", () => {
  const open: Spend = { limitUsd: null, spentUsd: 12 };
  assert.equal(remaining(open), null);
  assert.equal(canAfford(open, 1_000), true);

  const capped: Spend = { limitUsd: 1, spentUsd: 0.9 };
  assert.equal(remaining(capped), 0.1);
  assert.equal(canAfford(capped, 0.05), true);
  assert.equal(canAfford(capped, 0.2), false);
});

test("spending is recorded truthfully even past the ceiling", () => {
  const spend: Spend = { limitUsd: 1, spentUsd: 0.98 };
  const after = charge(spend, 0.05);
  assert.equal(after.spentUsd, 1.03, "the real number is kept, not clamped into a lie");
  assert.equal(remaining(after), 0);
});

test("a trivial request routes cheap and a migration routes strong", () => {
  const trivial = assessComplexity({ prompt: "rename the variable", contextTokens: 2_000 });
  const big = assessComplexity({
    prompt: "migrate the database schema and refactor the distributed concurrency layer",
    contextTokens: 60_000,
    steps: 5,
  });
  assert.ok(trivial < 0.35, `trivial scored ${trivial}`);
  assert.ok(big >= 0.7, `big scored ${big}`);

  assert.equal(chooseModel({ models: MODELS, complexity: trivial, contextTokens: 2_000, spend: { limitUsd: 5, spentUsd: 0 } })?.tier, "cheap");
  assert.equal(chooseModel({ models: MODELS, complexity: big, contextTokens: 60_000, spend: { limitUsd: 5, spentUsd: 0 } })?.tier, "strong");
});

test("a nearly exhausted budget falls back to the cheapest model", () => {
  const spend: Spend = { limitUsd: 1, spentUsd: 0.95 };
  const chosen = chooseModel({ models: MODELS, complexity: 0.95, contextTokens: 2_000, spend });
  assert.equal(chosen?.tier, "cheap", "a tight budget must not buy the strong model");
});

test("nothing is returned when no model fits the context or the budget", () => {
  const huge = { models: MODELS, complexity: 0.2, contextTokens: 500_000, spend: { limitUsd: 5, spentUsd: 0 } };
  assert.equal(chooseModel(huge), null, "a context that does not fit must not be sent anyway");

  const broke = { models: MODELS, complexity: 0.2, contextTokens: 1_000, spend: { limitUsd: 1, spentUsd: 1 } };
  assert.equal(chooseModel(broke), null, "an exhausted budget must stop, not borrow");
});
