// Proof of state.
//
// Detection is the part that has to be right: a verifier that finds nothing and says
// nothing is worse than no verifier, because it reads as a clean bill of health.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChecks, runChecks, summarize, type Check } from "./index.ts";

async function withWorkspace(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-verify-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("package.json scripts become checks, cheapest kind first", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          build: "vite build",
          test: "node --test",
          typecheck: "tsc --noEmit",
          lint: "eslint .",
        },
      }),
      "utf8",
    );

    const checks = await detectChecks(dir);
    assert.deepEqual(
      checks.map((check) => check.kind),
      ["typecheck", "test", "lint", "build"],
    );
    assert.equal(checks.find((check) => check.kind === "test")?.command, "npm test");
    assert.equal(checks.find((check) => check.kind === "typecheck")?.command, "npm run typecheck");
  });
});

test("the package manager comes from the lockfile", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");

    const checks = await detectChecks(dir);
    assert.equal(checks[0]?.command, "pnpm test");
  });
});

test("a TypeScript project without a typecheck script still gets typechecked", async () => {
  await withWorkspace(async (dir) => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
    await writeFile(join(dir, "tsconfig.json"), "{}", "utf8");
    await mkdir(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
    await writeFile(join(dir, "node_modules", "typescript", "bin", "tsc"), "", "utf8");

    const checks = await detectChecks(dir);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.kind, "typecheck");
    assert.match(checks[0]?.command ?? "", /tsc -p tsconfig\.json --noEmit/);
  });
});

test("no manifest means no checks, and the summary says so instead of implying a pass", async () => {
  await withWorkspace(async (dir) => {
    assert.deepEqual(await detectChecks(dir), []);
    const report = await runChecks(dir, []);
    assert.equal(report.ok, false, "an empty run must not read as success");
    assert.match(summarize(report), /nothing was proven/i);
  });
});

test("a passing check is reported as passing", async () => {
  await withWorkspace(async (dir) => {
    const checks: Check[] = [
      { name: "trivial", kind: "test", command: 'node -e "process.exit(0)"', source: "test" },
    ];
    const report = await runChecks(dir, checks);
    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0]?.ok, true);
    assert.equal(report.checks[0]?.code, 0);
  });
});

test("a failing check stops the run and the rest are named as skipped", async () => {
  await withWorkspace(async (dir) => {
    const checks: Check[] = [
      { name: "fails", kind: "test", command: 'node -e "console.error(\'boom\'); process.exit(3)"', source: "test" },
      { name: "never", kind: "lint", command: 'node -e "process.exit(0)"', source: "test" },
    ];
    const report = await runChecks(dir, checks);
    assert.equal(report.ok, false);
    assert.equal(report.checks[0]?.code, 3);
    assert.match(report.checks[0]?.output ?? "", /boom/);
    assert.deepEqual(report.skipped.map((entry) => entry.name), ["never"]);

    const text = summarize(report);
    assert.match(text, /FAIL fails/);
    assert.match(text, /SKIPPED never/);
  });
});

test("a hung check is killed and reported as a timeout", async () => {
  await withWorkspace(async (dir) => {
    const checks: Check[] = [
      { name: "hangs", kind: "test", command: 'node -e "setTimeout(() => {}, 10000)"', source: "test" },
    ];
    const report = await runChecks(dir, checks, { timeoutMs: 300 });
    assert.equal(report.ok, false);
    assert.equal(report.checks[0]?.timedOut, true);
  });
});
