// The knowledge graph — a local memory of what the user's words refer to.
//
// The problem it solves is the one every agent has: a person says "the dashboard",
// and the agent greps the repository, reads six files, and puts all of it in the
// context window to work out that they meant `src/pages/Dashboard.tsx`. That costs
// tokens, latency, and — because tokens cost energy to produce — power. It costs more
// on a laptop, which is where Weaver runs.
//
// The fix is boring and that is the point: remember the resolution once, retrieve it in
// O(1) the next time, and do not re-derive it. The context window gets smaller by
// default, which is a saving that compounds every turn rather than a one-off.
//
// THE TRAP. Radware's *ZombieAgent* research (Jan 2026) showed that persistent memory is
// the ideal persistence channel for prompt injection: an injection that lands in memory
// outlives the input that carried it and becomes a standing insider, silently changing
// behaviour forever after. A memory the agent reads on every turn is exactly the thing
// an attacker wants to write to.
//
// So this file is built on the trust layer rather than beside it:
//   · Every entry carries provenance. Only `user`-confirmed entries are authoritative.
//   · `external`-derived entries are stored and retrievable but never auto-applied.
//   · The reject list is the human's veto, and it is never overridden by inference.
//
// Nothing here is a model call. It is a lookup table with provenance attached, which is
// the only shape that can be both fast and accountable.
import type { Provenance } from "../core/types.ts";

export interface Entry {
  /** Normalised phrase, used as the key. */
  phrase: string;
  /** What the phrase refers to. A path, a name, a fact — not an instruction. */
  resolvesTo: string;
  provenance: Provenance;
  /** Where the knowledge came from, for the same reason tool calls carry provenance. */
  source: string;
  createdAt: number;
  /** How many times this has resolved. Frequently used references surface first. */
  hits: number;
}

export interface Reject {
  phrase: string;
  reason: string;
  provenance: Provenance;
  createdAt: number;
}

export interface Graph {
  entries: Map<string, Entry>;
  rejected: Map<string, Reject>;
}

export function newGraph(): Graph {
  return { entries: new Map(), rejected: new Map() };
}

/**
 * Normalise a phrase to its key.
 *
 * Case, punctuation, and whitespace folding — because "The Dashboard", "the dashboard"
 * and "the  dashboard!" are the same referent to a human, and a memory that misses
 * because of an apostrophe is worse than no memory.
 */
export function normalise(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[`*_~'"“”‘’]/g, "")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words long enough to carry meaning. "the", "a", "of" resolve nothing. */
const STOPWORDS = new Set(["the", "a", "an", "of", "to", "in", "for", "and", "or", "my", "our", "that", "this", "it", "is", "on", "at", "with"]);

function tokens(phrase: string): string[] {
  return normalise(phrase)
    .split(" ")
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

export interface Remembered {
  phrase: string;
  resolvesTo: string;
  provenance: Provenance;
  source: string;
}

/**
 * Record, or update, a resolution.
 *
 * A `user`-confirmed entry may override a previous rejection — the human changing their
 * mind is the one thing allowed to. An `external`-derived entry may not: content the
 * user does not control does not get to rewrite what their words mean.
 */
export function remember(graph: Graph, input: Remembered, now: number = Date.now()): void {
  const key = normalise(input.phrase);
  if (key.length === 0) return;

  const existing = graph.entries.get(key);
  if (existing !== undefined) {
    existing.resolvesTo = input.resolvesTo;
    existing.provenance = input.provenance;
    existing.source = input.source;
    if (input.provenance === "user") graph.rejected.delete(key);
    return;
  }

  graph.entries.set(key, {
    phrase: key,
    resolvesTo: input.resolvesTo,
    provenance: input.provenance,
    source: input.source,
    createdAt: now,
    hits: 0,
  });
  if (input.provenance === "user") graph.rejected.delete(key);
}

/** The human's veto. Rejected phrases never resolve and never enter context again. */
export function reject(graph: Graph, phrase: string, reason: string, provenance: Provenance = "user", now: number = Date.now()): void {
  const key = normalise(phrase);
  if (key.length === 0) return;
  graph.rejected.set(key, { phrase: key, reason, provenance, createdAt: now });
  graph.entries.delete(key);
}

export interface Resolution {
  entry: Entry;
  /** "exact" is a direct hit; "partial" is a token overlap the caller should sanity-check. */
  match: "exact" | "partial";
}

/**
 * Look up what a phrase refers to, or null.
 *
 * Counts a hit as it goes, so the graph learns which references actually matter without
 * anything having to be configured.
 */
export function resolve(graph: Graph, phrase: string): Resolution | null {
  const key = normalise(phrase);
  if (key.length === 0) return null;
  if (graph.rejected.has(key)) return null;

  const exact = graph.entries.get(key);
  if (exact !== undefined) {
    exact.hits += 1;
    return { entry: exact, match: "exact" };
  }

  // Partial match: the strongest overlap of significant words, with enough of them to
  // mean something. Being generous here re-creates the problem this exists to solve, so
  // the bar is deliberately high — a miss costs a grep, and a wrong hit costs a wrong file.
  const wanted = tokens(phrase);
  if (wanted.length === 0) return null;

  let best: { entry: Entry; score: number } | null = null;
  for (const entry of graph.entries.values()) {
    if (graph.rejected.has(entry.phrase)) continue;
    const have = new Set(tokens(entry.phrase));
    const shared = wanted.filter((word) => have.has(word)).length;
    const score = shared / Math.max(wanted.length, have.size);
    if (shared === 0) continue;
    if (best === null || score > best.score) best = { entry, score };
  }

  // Two thirds of the words must agree. Below that the phrase is probably a different
  // thing that happens to share a noun.
  if (best === null || best.score < 0.66) return null;
  best.entry.hits += 1;
  return { entry: best.entry, match: "partial" };
}

export interface ContextOptions {
  /** How many entries to inject. The saving is bounded by this. */
  limit?: number;
  /** Character budget, because a count is not a cost. */
  maxChars?: number;
  /** Only surface entries at least this many tokens long — one-word entries are noise. */
  minPhraseLength?: number;
}

const DEFAULT_LIMIT = 24;
const DEFAULT_MAX_CHARS = 1_600;
const DEFAULT_MIN_LENGTH = 4;

/**
 * What to inject into the model's context.
 *
 * This is where the token saving actually happens, and where the design has to be
 * honest about a trade: a memory you never inject is useless, and one you inject in
 * full is the context bloat it was meant to prevent. So it is bounded twice — by entry
 * count and by characters — and sorted by use, so the entries that earn their place go
 * in first.
 *
 * Rejected phrases are excluded by construction, which is the point of them: the user
 * said a reference was irrelevant, and irrelevant references are exactly what should not
 * be paid for again on every turn.
 */
export function contextFor(graph: Graph, options: ContextOptions = {}): string {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const minLength = options.minPhraseLength ?? DEFAULT_MIN_LENGTH;

  const candidates = [...graph.entries.values()]
    .filter((entry) => entry.phrase.length >= minLength && !graph.rejected.has(entry.phrase))
    // Most used first; ties broken by most recent, so a new reference is not starved.
    .sort((a, b) => b.hits - a.hits || b.createdAt - a.createdAt);

  const lines: string[] = [];
  let used = 0;
  for (const entry of candidates) {
    if (lines.length >= limit) break;
    const line = `  "${entry.phrase}" → ${entry.resolvesTo}`;
    if (used + line.length > maxChars) break;
    // Unconfirmed knowledge is marked, never silently trusted — the model should treat
    // it as a hint to verify, not as a fact it is allowed to act on unchallenged.
    const suffix = entry.provenance === "user" ? "" : ` (unverified: from ${entry.source})`;
    lines.push(`${line}${suffix}`);
    used += line.length + suffix.length;
  }

  if (lines.length === 0) return "";
  return ["Known references (use these instead of searching):", ...lines].join("\n");
}

/** Rough token estimate. Approximate on purpose — the ratio is what matters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface GraphStats {
  entries: number;
  rejected: number;
  hits: number;
}

export function stats(graph: Graph): GraphStats {
  let hits = 0;
  for (const entry of graph.entries.values()) hits += entry.hits;
  return { entries: graph.entries.size, rejected: graph.rejected.size, hits };
}
