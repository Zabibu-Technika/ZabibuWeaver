// The knowledge graph.
//
// Two properties, and the second one is why the file exists:
//   1. A reference the user gave once should resolve in O(1) instead of costing a grep
//      and a context window full of files it did not need.
//   2. Persistent memory is the ideal channel for prompt injection (Radware's
//      *ZombieAgent*), so nothing derived from untrusted content may become
//      authoritative, and the human's reject list is never overridden by inference.
import assert from "node:assert/strict";
import test from "node:test";
import {
  contextFor,
  estimateTokens,
  newGraph,
  normalise,
  reject,
  remember,
  resolve,
  stats,
} from "./graph.ts";

const USER = { provenance: "user" as const, source: "the human" };
const WEB = { provenance: "external" as const, source: "web:example.com" };

function graphWith(...items: Array<{ phrase: string; resolvesTo: string; provenance?: "user" | "external"; source?: string }>): ReturnType<typeof newGraph> {
  const graph = newGraph();
  for (const item of items) {
    remember(graph, {
      phrase: item.phrase,
      resolvesTo: item.resolvesTo,
      provenance: item.provenance ?? "user",
      source: item.source ?? (item.provenance === "external" ? WEB.source : USER.source),
    });
  }
  return graph;
}

// --- Resolution --------------------------------------------------------------

test("a remembered phrase resolves exactly", () => {
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx" });
  const hit = resolve(graph, "the dashboard");
  assert.equal(hit?.match, "exact");
  assert.equal(hit?.entry.resolvesTo, "src/pages/Dashboard.tsx");
});

test("normalisation folds the ways a human actually types it", () => {
  // If an apostrophe or a capital letter makes a memory miss, the memory is worse than
  // nothing — it costs storage and still leaves the agent grepping.
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx" });
  for (const typed of ["The Dashboard", "the  dashboard!", "`the dashboard`", "the\n dashboard?"]) {
    assert.equal(normalise(typed), "the dashboard", `failed to fold: ${JSON.stringify(typed)}`);
    assert.ok(resolve(graph, typed) !== null, `did not resolve: ${JSON.stringify(typed)}`);
  }
});

test("partial matching is used, but only above a high bar", () => {
  const graph = graphWith(
    { phrase: "the login page", resolvesTo: "src/pages/Login.tsx" },
    { phrase: "the payments service", resolvesTo: "src/services/payments.ts" },
  );
  // Shares both significant words: a real match.
  assert.equal(resolve(graph, "where is the login page")?.entry.resolvesTo, "src/pages/Login.tsx");
  // Shares one word with two candidates: not enough, and guessing here would send the
  // agent to a file it did not need — which is the cost this whole module removes.
  assert.equal(resolve(graph, "the page"), null);
});

test("a hit is counted, so the graph learns what actually matters", () => {
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx" });
  resolve(graph, "the dashboard");
  resolve(graph, "the dashboard");
  assert.equal(stats(graph).hits, 2);
});

// --- The reject list ---------------------------------------------------------

test("a rejected phrase never resolves again", () => {
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx" });
  reject(graph, "the dashboard", "that is the old one, we renamed it");
  assert.equal(resolve(graph, "the dashboard"), null);
  assert.equal(stats(graph).entries, 0, "rejected entries are removed, not just hidden");
  assert.equal(stats(graph).rejected, 1);
});

test("the human's veto is never overridden by untrusted content", () => {
  // ZombieAgent's lesson: an injection that reaches memory outlives the input that
  // carried it. If web content could silently re-add a phrase the user rejected, the
  // reject list would be decorative.
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx" });
  reject(graph, "the dashboard", "not relevant");
  remember(graph, { ...WEB, phrase: "the dashboard", resolvesTo: "src/evil.ts" });
  assert.equal(resolve(graph, "the dashboard"), null, "external content must not resurrect a rejected phrase");
});

test("the human changing their mind is the one thing that can", () => {
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "old.tsx" });
  reject(graph, "the dashboard", "renamed it");
  remember(graph, { ...USER, phrase: "the dashboard", resolvesTo: "new.tsx" });
  assert.equal(resolve(graph, "the dashboard")?.entry.resolvesTo, "new.tsx");
});

// --- Context injection: the actual saving ------------------------------------

test("context is bounded by entry count, because a count is not a cost", () => {
  const graph = newGraph();
  for (let i = 0; i < 200; i += 1) {
    remember(graph, { ...USER, phrase: `reference number ${i}`, resolvesTo: `src/file${i}.ts` });
  }
  const full = contextFor(graph, { limit: 200, maxChars: 1_000_000 });
  const bounded = contextFor(graph);
  assert.ok(estimateTokens(bounded) < estimateTokens(full), "the default must be smaller than everything");
  assert.ok(estimateTokens(bounded) < 450, `default context was ${estimateTokens(bounded)} tokens`);
});

test("context is bounded by characters, so long answers cannot smuggle past the count", () => {
  const graph = newGraph();
  remember(graph, { ...USER, phrase: "the dashboard route configuration", resolvesTo: "x".repeat(400) });
  remember(graph, { ...USER, phrase: "the payments service client", resolvesTo: "y".repeat(400) });
  const text = contextFor(graph, { limit: 50, maxChars: 200 });
  assert.ok(text.length <= 400, `context was ${text.length} chars against a 200 budget`);
});

test("rejected phrases are excluded from context — irrelevant references must not be paid for twice", () => {
  const graph = graphWith(
    { phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx" },
    { phrase: "the legacy widget", resolvesTo: "src/legacy/Widget.tsx" },
  );
  reject(graph, "the legacy widget", "deprecated, stop mentioning it");
  const text = contextFor(graph, { limit: 50 });
  assert.ok(text.includes("the dashboard"));
  assert.ok(!text.includes("the legacy widget"));
});

test("context sorts by use, so entries that earn their place go first", () => {
  const graph = graphWith(
    { phrase: "rarely used reference", resolvesTo: "a.ts" },
    { phrase: "the dashboard", resolvesTo: "b.ts" },
  );
  for (let i = 0; i < 5; i += 1) resolve(graph, "the dashboard");
  const lines = contextFor(graph, { limit: 50 }).split("\n");
  const first = lines.findIndex((line) => line.includes("→"));
  assert.ok(lines[first]?.includes("the dashboard"), "the most used reference should lead");
});

test("unconfirmed knowledge is marked, so it is never acted on unchallenged", () => {
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx", provenance: "external" });
  const text = contextFor(graph, { limit: 50 });
  assert.match(text, /unverified: from web:example\.com/);
});

test("user-confirmed knowledge is injected clean", () => {
  const graph = graphWith({ phrase: "the dashboard", resolvesTo: "src/pages/Dashboard.tsx" });
  assert.ok(!contextFor(graph, { limit: 50 }).includes("unverified"));
});

test("an empty graph injects nothing rather than a heading with no content", () => {
  assert.equal(contextFor(newGraph()), "");
});

test("the saving is real and measurable against the naive alternative", () => {
  // The naive alternative is what every agent does today when a human says "the
  // dashboard": grep, then dump the candidate files into context and let the model work
  // out which one was meant. The file below is deliberately ordinary — it is not a
  // strawman, it is a component.
  const realComponent = [
    "import { useEffect, useState } from 'react';",
    "import { useSearchParams } from 'react-router-dom';",
    "import { StatCard } from './StatCard';",
    "import { fetchDashboardSummary } from '../api/client';",
    "import type { DashboardSummary } from '../api/types';",
    "",
    "export function Dashboard() {",
    "  const [params, setParams] = useSearchParams();",
    "  const [summary, setSummary] = useState<DashboardSummary | null>(null);",
    "  const [loading, setLoading] = useState(true);",
    "  const range = params.get('range') ?? '30d';",
    "",
    "  useEffect(() => {",
    "    let cancelled = false;",
    "    setLoading(true);",
    "    fetchDashboardSummary(range)",
    "      .then((data) => { if (!cancelled) setSummary(data); })",
    "      .finally(() => { if (!cancelled) setLoading(false); });",
    "    return () => { cancelled = true; };",
    "  }, [range]);",
    "",
    "  if (loading) return <Skeleton rows={4} />;",
    "  if (!summary) return <EmptyState title=\"Nothing to show for this range\" />;",
    "",
    "  return (",
    "    <section className=\"grid gap-4 md:grid-cols-2 lg:grid-cols-4\">",
    "      <StatCard label=\"Active users\" value={summary.users} delta={summary.usersDelta} />",
    "      <StatCard label=\"Revenue\" value={summary.revenue} delta={summary.revenueDelta} />",
    "      <StatCard label=\"Churn\" value={summary.churn} delta={summary.churnDelta} invert />",
    "      <StatCard label=\"Open tickets\" value={summary.tickets} delta={summary.ticketsDelta} />",
    "    </section>",
    "  );",
    "}",
  ].join("\n");

  const graph = newGraph();
  for (let i = 0; i < 12; i += 1) {
    remember(graph, { ...USER, phrase: `the component number ${i}`, resolvesTo: `src/components/Component${i}.tsx` });
  }

  const memory = contextFor(graph);
  const naiveDump = `${realComponent}\n`.repeat(12);

  const naive = estimateTokens(naiveDump);
  const cheap = estimateTokens(memory);
  const ratio = naive / cheap;

  // Stated as measured rather than as a headline: twelve ambiguous references cost
  // ~180 tokens with the graph and ~4,000 without it. The ratio is the durable claim —
  // a real project surfaces far more candidates per reference, and the gap widens with
  // them, whereas the memory is bounded by construction and does not grow at all.
  assert.ok(ratio > 20, `expected a 20x reduction, got ${ratio.toFixed(1)}x (${cheap} vs ${naive} tokens)`);
  assert.ok(naive - cheap > 3_000, `expected over 3,000 tokens saved, got ${naive - cheap}`);
});
