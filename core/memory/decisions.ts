// Decision ledger — why, not just what.
//
// Chat history records what was said. It does not record what was *decided*, and that is
// the thing a long-running agent keeps losing: three hours in, it proposes the approach
// you rejected at minute ten, because the rejection was a sentence buried in a transcript
// that has since been compacted away.
//
// So decisions are stored separately, structured, and append-only. A decision is never
// edited or deleted. Changing your mind appends a new entry that supersedes the old one,
// which leaves the reasoning trail intact — the same property that makes an audit log
// useful and a wiki useless.
//
// WHY JSONL
//
// One JSON object per line, appended with O_APPEND. That is the only format where a
// power cut mid-write costs you the last line and nothing else: every earlier line is
// still complete and parseable. A single JSON array rewritten on each change would lose
// the whole ledger to one interrupted write, and interrupted writes are the normal case
// on a laptop that runs on a battery and a grid that does not always cooperate.
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type DecisionKind =
  /** A choice that was made and should not be silently remade. */
  | "choice"
  /** An approach that was considered and rejected, with the reason. */
  | "rejection"
  /** A boundary that constrains future work. */
  | "constraint"
  /** Something assumed true but not verified. */
  | "assumption";

export type DecisionSource = "user" | "agent" | "judge";

export interface Decision {
  id: string;
  /** ISO timestamp. */
  at: string;
  kind: DecisionKind;
  title: string;
  rationale: string;
  alternatives: string[];
  constraints: string[];
  tags: string[];
  source: DecisionSource;
  /** The decision this one replaces. The old entry stays in the log, untouched. */
  supersedes?: string;
}

export interface NewDecision {
  kind: DecisionKind;
  title: string;
  rationale: string;
  alternatives?: string[];
  constraints?: string[];
  tags?: string[];
  source?: DecisionSource;
  supersedes?: string;
}

export interface Ledger {
  /** Absolute path to the JSONL file. */
  file: string;
}

export function ledgerFor(workspace: string): Ledger {
  return { file: join(resolve(workspace), ".weaver", "decisions.jsonl") };
}

const MAX_TITLE = 200;
const MAX_RATIONALE = 4_000;
const MAX_LIST_ITEMS = 12;
const MAX_ITEM = 400;

function clampText(value: unknown, limit: number, field: string): string {
  if (typeof value !== "string") throw new Error(`decision ${field} must be a string`);
  const text = value.trim();
  if (text.length === 0) throw new Error(`decision ${field} must not be empty`);
  return text.length > limit ? text.slice(0, limit) : text;
}

function clampList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`decision ${field} must be an array`);
  return value
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => clampText(item, MAX_ITEM, field))
    .filter((item) => item.length > 0);
}

/**
 * A stable id from the content, so recording the same decision twice is idempotent.
 *
 * `supersedes` is part of the identity because superseding is a distinct act: recording
 * "use SQLite" and later recording "use SQLite, superseding the Postgres decision" must
 * not be collapsed into the first entry, which would silently drop the reversal.
 */
function idFor(kind: string, title: string, rationale: string, supersedes?: string): string {
  return createHash("sha256")
    .update(`${kind}\u0000${title}\u0000${rationale}\u0000${supersedes ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function normalise(input: NewDecision, now: Date): Decision {
  const kind = input.kind;
  if (kind !== "choice" && kind !== "rejection" && kind !== "constraint" && kind !== "assumption") {
    throw new Error(`decision kind must be choice|rejection|constraint|assumption, got "${String(kind)}"`);
  }
  const title = clampText(input.title, MAX_TITLE, "title");
  const rationale = clampText(input.rationale, MAX_RATIONALE, "rationale");
  const source = input.source ?? "agent";
  if (source !== "user" && source !== "agent" && source !== "judge") {
    throw new Error(`decision source must be user|agent|judge, got "${String(source)}"`);
  }

  const decision: Decision = {
    id: idFor(kind, title, rationale, input.supersedes),
    at: now.toISOString(),
    kind,
    title,
    rationale,
    alternatives: clampList(input.alternatives, "alternatives"),
    constraints: clampList(input.constraints, "constraints"),
    tags: clampList(input.tags, "tags").map((tag) => tag.toLowerCase()),
    source,
  };
  if (input.supersedes !== undefined) decision.supersedes = input.supersedes;
  return decision;
}

/**
 * Append one JSONL record, repairing a torn tail first.
 *
 * A power cut leaves the last line half-written and, critically, without a newline. The
 * next append would concatenate onto that fragment and destroy the new record too —
 * turning one lost line into a lost line plus a corrupt one. Looking at the last byte is
 * cheap and makes the format actually crash-safe, which is the whole reason it is JSONL.
 */
async function appendLine(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  let needsNewline = false;
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const buffer = Buffer.alloc(1);
        await handle.read(buffer, 0, 1, size - 1);
        needsNewline = buffer[0] !== 0x0a;
      }
    } finally {
      await handle.close();
    }
  } catch {
    // The file does not exist yet; nothing to repair.
  }
  await appendFile(file, `${needsNewline ? "\n" : ""}${line}\n`, "utf8");
}

/**
 * Append a decision. Returns the entry that is now in the log — the existing one when an
 * identical decision was already recorded.
 */
export async function record(ledger: Ledger, input: NewDecision, now: Date = new Date()): Promise<Decision> {
  const decision = normalise(input, now);
  const { decisions } = await read(ledger);
  const existing = decisions.find((candidate) => candidate.id === decision.id);
  if (existing !== undefined) return existing;

  await appendLine(ledger.file, JSON.stringify(decision));
  return decision;
}

/**
 * The whole log, oldest first, plus how many lines were unreadable.
 *
 * A corrupt line is skipped rather than thrown: one torn write must not make every
 * decision before it inaccessible, which is exactly what a strict parse would do.
 */
export async function read(ledger: Ledger): Promise<{ decisions: Decision[]; corrupt: number }> {
  let raw: string;
  try {
    raw = await readFile(ledger.file, "utf8");
  } catch {
    return { decisions: [], corrupt: 0 };
  }

  const decisions: Decision[] = [];
  let corrupt = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Decision;
      if (typeof parsed.id === "string" && typeof parsed.title === "string") decisions.push(parsed);
      else corrupt += 1;
    } catch {
      corrupt += 1;
    }
  }
  return { decisions, corrupt };
}

/**
 * Decisions that still stand: everything not superseded by a later entry.
 *
 * Superseding is transitive, so a chain of three reversals leaves only the last one
 * active while all three remain in the log.
 */
export async function active(ledger: Ledger): Promise<Decision[]> {
  const { decisions } = await read(ledger);
  const superseded = new Set<string>();
  for (const decision of decisions) {
    if (decision.supersedes !== undefined) superseded.add(decision.supersedes);
  }

  // Identical content can appear twice when a decision was recorded plainly and then
  // again as a reversal. Keep the newest — it is the entry holding the supersede — and
  // do not show the user the same decision twice.
  const byContent = new Map<string, Decision>();
  for (const decision of decisions) {
    if (superseded.has(decision.id)) continue;
    byContent.set(`${decision.kind}\u0000${decision.title}\u0000${decision.rationale}`, decision);
  }

  return [...byContent.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export interface ContextOptions {
  /** Only include decisions carrying at least one of these tags. */
  tags?: string[];
  limit?: number;
  maxChars?: number;
}

/**
 * A bounded block for the system prompt.
 *
 * Bounded is the point. An unbounded memory is a memory that eventually fills the
 * context window with decisions that no longer matter, which is the same failure as
 * having none — you just pay more for it.
 */
export async function context(ledger: Ledger, options: ContextOptions = {}): Promise<string> {
  const limit = options.limit ?? 12;
  const maxChars = options.maxChars ?? 2_000;
  const wanted = options.tags?.map((tag) => tag.toLowerCase());

  const decisions = await active(ledger);
  const filtered =
    wanted === undefined || wanted.length === 0
      ? decisions
      : decisions.filter((decision) => decision.tags.some((tag) => wanted.includes(tag)));

  const lines: string[] = [];
  let used = 0;
  for (const decision of [...filtered].reverse().slice(0, limit)) {
    const constraints = decision.constraints.length > 0 ? ` Constraints: ${decision.constraints.join("; ")}.` : "";
    const line = `- [${decision.kind}] ${decision.title} — ${decision.rationale}${constraints}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}
