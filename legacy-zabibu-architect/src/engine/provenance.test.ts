// Provenance for the vendored engine.
//
// The sign-off's whole claim is that the judgement is independent, deterministic,
// and checkable. "Vendored" on its own proves none of that: a copy you cannot
// verify against its source is just a fork wearing a costume. These tests are what
// convert the copy into a claim:
//
//   1. always: the vendored files still hash to what `provenance.json` records.
//      If anyone edits them — even a comment — this fails.
//   2. when the upstream checkout is present: the vendored files are byte-identical
//      to it. This fails the moment Canary's engine changes, which is the point —
//      the fix is to re-vendor deliberately, not to discover the drift in
//      production when a receipt stops matching.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const engineDir = join(dirname(fileURLToPath(import.meta.url)));
const provenance = JSON.parse(readFileSync(join(engineDir, "provenance.json"), "utf8")) as {
  source: { engineDir: string; commit: string | null; dirty: boolean | null };
  files: Record<string, { sha256: string; bytes: number }>;
};

/**
 * Where a sibling Canary checkout would be, by convention:
 * `Default Project/zabibu-canary/packages/engine/src` sits beside `weaver/`.
 */
function upstreamDir(): string | null {
  const explicit = process.env.WEAVER_ENGINE_SRC;
  const candidates = [
    explicit,
    // weaver/src/engine → Default Project → zabibu-canary/packages/engine/src
    join(engineDir, "..", "..", "..", "zabibu-canary", provenance.source.engineDir),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) {
      return resolve(candidate);
    }
  }
  return null;
}

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

test("the vendored engine still matches its provenance record", () => {
  const names = Object.keys(provenance.files);
  assert.ok(names.length > 0, "provenance.json lists no files");

  for (const name of names) {
    const file = join(engineDir, name);
    assert.ok(existsSync(file), `${name} is listed in provenance but missing on disk`);

    const record = provenance.files[name];
    assert.ok(record !== undefined, `no provenance record for ${name}`);

    assert.equal(
      sha256(file),
      record.sha256,
      `${name} has been edited. Vendored files are byte-for-byte copies and must not be\n` +
        `touched — re-vendor with \`npm run vendor:engine\` if the change was intended.`,
    );
    assert.equal(readFileSync(file).length, record.bytes, `${name} changed size`);
  }
});

test("the vendored engine is byte-identical to upstream, when upstream is present", (t) => {
  const upstream = upstreamDir();
  if (upstream === null) {
    t.skip("no upstream checkout here — Weaver still runs, on the pinned copy");
    return;
  }

  const drifted: string[] = [];
  for (const name of Object.keys(provenance.files)) {
    const from = join(upstream, name);
    if (!existsSync(from)) {
      drifted.push(`${name} (gone upstream)`);
      continue;
    }
    if (sha256(from) !== provenance.files[name]?.sha256) drifted.push(name);
  }

  assert.deepEqual(
    drifted,
    [],
    `the upstream engine has moved: ${drifted.join(", ")}.\n` +
      `  Re-vendor with \`npm run vendor:engine\` once you mean to adopt the change.\n` +
      `  Until then the sign-off is still the pinned copy, and receipts still match it.`,
  );
});

test("the vendored engine is a single self-contained closure", () => {
  // No import may escape the vendored set — that is what lets Weaver run with no
  // sibling checkout and no dependencies. `ledger.ts` is excluded on purpose, so
  // crypto must not appear here either.
  const allowed = new Set(["analyze.ts", "impact.ts", "plain.ts"]);
  for (const name of Object.keys(provenance.files)) {
    const source = readFileSync(join(engineDir, name), "utf8");
    for (const match of source.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith("node:")) {
        assert.fail(`${name} imports ${specifier} — the judge must stay pure and dependency-free`);
      }
      const target = specifier.replace(/^\.\//, "");
      assert.ok(
        allowed.has(target),
        `${name} imports "${specifier}", which is outside the vendored set`,
      );
    }
  }
});
