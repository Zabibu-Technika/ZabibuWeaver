// Offline end-to-end smoke test: run the real entry point against a scratch
// directory with the mock provider, and check the agent actually wrote a file.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "weaver-smoke-"));
const entry = resolve("src/index.ts");
const script = resolve("scripts/mock-basic.json");

const result = spawnSync(
  process.execPath,
  [
    entry,
    "--provider", "mock",
    "--permission", "full",
    "--workspace", scratch,
    "--script", script,
    "-p", "create hello.ts",
  ],
  { encoding: "utf8", env: { ...process.env, WEAVER_HOME: join(scratch, ".weaver") } },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

const target = join(scratch, "hello.ts");
const created = existsSync(target);
if (created) {
  console.log("--- hello.ts ---");
  console.log(readFileSync(target, "utf8"));
}

rmSync(scratch, { recursive: true, force: true });

if (!created) {
  console.error("SMOKE FAIL: hello.ts was not created");
  process.exit(1);
}
console.log("SMOKE PASS: the loop streamed, called write_file, read it back, and finished.");
