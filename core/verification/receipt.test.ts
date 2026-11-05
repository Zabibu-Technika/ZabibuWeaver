// Proof receipts.
//
// The property that matters is the label: a green run is not "proved" if the turn also
// rewrote the test. These tests exist to keep that honesty from eroding into a boolean.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerificationReport } from "./index.ts";
import {
  isTestPath,
  listReceipts,
  receiptMarkdown,
  receiptsDir,
  statusFor,
  summarizeProof,
  writeReceipt,
} from "./receipt.ts";

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    ok: true,
    checks: [
      {
        name: "test",
        kind: "test",
        command: "npm test",
        source: "package.json scripts",
        ok: true,
        code: 0,
        ms: 120,
        timedOut: false,
        output: "all good\n",
      },
    ],
    skipped: [],
    ms: 130,
    ...overrides,
  };
}

async function withWorkspace(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-receipt-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the status is evidence-based, not optimistic", () => {
  assert.equal(statusFor(null, { selfAuthored: false }), "unproven");
  assert.equal(statusFor(report({ checks: [] }), { selfAuthored: false }), "unproven");
  assert.equal(statusFor(report({ ok: false, checks: [{ ...report().checks[0]!, ok: false, code: 1 }] }), { selfAuthored: false }), "failed");
  assert.equal(statusFor(report({ skipped: [{ name: "lint", reason: "earlier failure" }] }), { selfAuthored: false }), "partial");
  assert.equal(statusFor(report(), { selfAuthored: true }), "partial", "a self-authored check is not independent proof");
  assert.equal(statusFor(report(), { selfAuthored: false }), "proved");
});

test("tests, test directories, and check configs count as authoring the judge", () => {
  for (const path of [
    "src/app.test.ts",
    "src/__tests__/app.ts",
    "test/helpers.ts",
    "tests/integration/login.py",
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    "Cargo.toml",
    "go.mod",
  ]) {
    assert.equal(isTestPath(path), true, `should be a check path: ${path}`);
  }
  for (const path of ["src/app.ts", "README.md", "scripts/smoke.mjs", "docs/testing.md"]) {
    assert.equal(isTestPath(path), false, `should not be a check path: ${path}`);
  }
});

test("a receipt records what ran, binds the output by digest, and stores no output", async () => {
  await withWorkspace(async (dir) => {
    const written = await writeReceipt({
      workspace: dir,
      report: report(),
      touched: ["src/app.ts"],
      analysisId: "abcd1234abcd1234",
    });

    assert.equal(written.receipt.status, "proved");
    assert.equal(written.receipt.checks[0]?.outputDigest.length, 64);
    assert.equal(written.receipt.checks[0]?.outputBytes, 9);
    assert.equal(written.receipt.analysisId, "abcd1234abcd1234");

    const markdown = receiptMarkdown(written.receipt);
    assert.match(markdown, /# Proof receipt — proved/);
    assert.match(markdown, /self-authored checks: no/);
    // The output itself must not appear in the artefact.
    assert.doesNotMatch(markdown, /all good/);
    assert.doesNotMatch(JSON.stringify(written.receipt), /all good/);
  });
});

test("touching a test file caps the receipt at partial and says why", async () => {
  await withWorkspace(async (dir) => {
    const written = await writeReceipt({
      workspace: dir,
      report: report(),
      touched: ["src/app.ts", "src/app.test.ts"],
    });

    assert.equal(written.receipt.status, "partial");
    assert.equal(written.receipt.selfAuthored, true);
    assert.match(receiptMarkdown(written.receipt), /not independent evidence/);
    assert.match(summarizeProof(written.receipt), /changed the checks themselves/);
  });
});

test("no checks produces an unproven receipt, not an empty pass", async () => {
  await withWorkspace(async (dir) => {
    const written = await writeReceipt({ workspace: dir, report: null, touched: ["src/app.ts"] });
    assert.equal(written.receipt.status, "unproven");
    assert.match(receiptMarkdown(written.receipt), /No verification checks were detected/);
  });
});

test("receipts are listed newest first and a damaged file does not hide the rest", async () => {
  await withWorkspace(async (dir) => {
    await writeReceipt({ workspace: dir, report: report(), touched: [], at: new Date("2026-01-01T00:00:00Z") });
    await writeReceipt({ workspace: dir, report: report(), touched: [], at: new Date("2026-01-02T00:00:00Z") });
    await writeFile(join(receiptsDir(dir), "broken.json"), "{not json", "utf8");

    const found = await listReceipts(dir);
    assert.equal(found.length, 2);
    assert.equal(found[0]?.at, "2026-01-02T00:00:00.000Z");
  });
});
