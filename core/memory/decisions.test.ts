// Decision ledger.
//
// The property that matters is not "it stores strings". It is that a reversal preserves
// the reasoning trail, and that a torn line does not take the rest of the memory with it.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { active, context, ledgerFor, read, record } from "./decisions.ts";

async function withLedger(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-decisions-"));
  try {
    // The ledger lives under <workspace>/.weaver, so the workspace is the parent.
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a decision records its reason, not just its outcome", async () => {
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    const decision = await record(ledger, {
      kind: "choice",
      title: "Use content-addressed checkpoints instead of shadow git",
      rationale: "git init measured ~2.3s here; a per-call snapshot would be disabled within a day",
      alternatives: ["shadow git per tool call", "copy the workspace to disk"],
      tags: ["storage", "performance"],
      source: "user",
    });

    assert.equal(decision.kind, "choice");
    assert.deepEqual(decision.alternatives, ["shadow git per tool call", "copy the workspace to disk"]);
    assert.deepEqual(decision.tags, ["storage", "performance"]);

    const { decisions, corrupt } = await read(ledger);
    assert.equal(decisions.length, 1);
    assert.equal(corrupt, 0);
    assert.match(decisions[0]?.rationale ?? "", /2\.3s/);
  });
});

test("recording the same decision twice is idempotent", async () => {
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    const input = { kind: "constraint" as const, title: "No new runtime dependencies", rationale: "zero-dep is a product promise" };

    const first = await record(ledger, input);
    const second = await record(ledger, input);

    assert.equal(first.id, second.id);
    assert.equal((await read(ledger)).decisions.length, 1, "a retry must not duplicate the entry");
  });
});

test("a reversal supersedes without erasing", async () => {
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    const original = await record(ledger, {
      kind: "choice",
      title: "Use SQLite for the ledger",
      rationale: "queries are easier",
    });
    await record(ledger, {
      kind: "rejection",
      title: "SQLite is out",
      rationale: "it adds a native dependency to a zero-dependency product",
      supersedes: original.id,
    });

    const all = await read(ledger);
    assert.equal(all.decisions.length, 2, "the original must remain in the log");

    const current = await active(ledger);
    assert.equal(current.length, 1);
    assert.equal(current[0]?.title, "SQLite is out");
  });
});

test("a supersede chain leaves only the last decision active", async () => {
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    const a = await record(ledger, { kind: "choice", title: "A", rationale: "first" });
    const b = await record(ledger, { kind: "choice", title: "B", rationale: "second", supersedes: a.id });
    await record(ledger, { kind: "choice", title: "C", rationale: "third", supersedes: b.id });

    const current = await active(ledger);
    assert.deepEqual(current.map((decision) => decision.title), ["C"]);
    assert.equal((await read(ledger)).decisions.length, 3);
  });
});

test("a supersede is not dropped when the same decision text already exists", async () => {
  // The silent-drop case: "use SQLite" was recorded once, then recorded again as a
  // reversal of "use Postgres". The ids must differ so the reversal is actually stored,
  // and the active list must not show "use SQLite" twice.
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    const postgres = await record(ledger, { kind: "choice", title: "Use Postgres", rationale: "familiar" });
    const plain = await record(ledger, { kind: "choice", title: "Use SQLite", rationale: "one file" });

    const reversal = await record(ledger, {
      kind: "choice",
      title: "Use SQLite",
      rationale: "one file",
      supersedes: postgres.id,
    });

    assert.notEqual(reversal.id, plain.id, "the reversal must be recorded, not merged away");
    assert.deepEqual((await active(ledger)).map((decision) => decision.title), ["Use SQLite"]);
    assert.equal((await read(ledger)).decisions.length, 3, "the log keeps every entry");
  });
});

test("one torn line does not make the earlier decisions unreadable", async () => {
  // The power-cut case. O_APPEND plus one object per line means the damage is bounded
  // to the line being written when the machine died.
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    await record(ledger, { kind: "choice", title: "Survives", rationale: "written before the outage" });
    await writeFile(ledger.file, '{"id":"half-writ', { flag: "a" });

    const { decisions, corrupt } = await read(ledger);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.title, "Survives");
    assert.equal(corrupt, 1);

    // And the ledger still accepts new entries afterwards.
    await record(ledger, { kind: "choice", title: "After", rationale: "the next write is a fresh line" });
    assert.equal((await read(ledger)).decisions.length, 2);
  });
});

test("context injection is bounded and newest-first", async () => {
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    for (let index = 0; index < 20; index += 1) {
      await record(ledger, {
        kind: "choice",
        title: `decision ${index}`,
        rationale: "r".repeat(120),
        tags: ["architecture"],
      });
    }

    const text = await context(ledger, { tags: ["architecture"], limit: 5, maxChars: 600 });
    const lines = text.split("\n").filter((line) => line.length > 0);
    assert.ok(lines.length <= 5);
    assert.ok(text.length <= 600, `context exceeded its budget: ${text.length}`);
    assert.match(lines[0] ?? "", /decision 19/, "the most recent decision comes first");
  });
});

test("invalid input is rejected rather than half-recorded", async () => {
  await withLedger(async (dir) => {
    const ledger = ledgerFor(dir);
    await assert.rejects(() => record(ledger, { kind: "choice", title: "", rationale: "x" }), /title/);
    await assert.rejects(() => record(ledger, { kind: "choice", title: "x", rationale: "  " }), /rationale/);
    assert.equal((await read(ledger)).decisions.length, 0);
  });
});
