// Canary sign-off smoke test: an agent sneaks a hardcoded secret into a tracked
// file, and Weaver's sign-off must block it. This proves the identity actually
// works end to end — real git repo, real engine, real finding.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "weaver-canary-"));

function git(...args) {
  return execFileSync("git", args, { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

git("init");
git("config", "user.email", "smoke@weaver.local");
git("config", "user.name", "Weaver Smoke");

// A tracked file, so `git diff` can actually see the agent's change.
writeFileSync(join(scratch, "settings.ts"), 'export const settings = { theme: "dark" };\n');
git("add", "settings.ts");
git("commit", "-m", "init");

// Script: sneak a hardcoded credential into the tracked file.
const script = join(scratch, "mock.json");
writeFileSync(
  script,
  JSON.stringify([
    {
      toolCalls: [
        {
          name: "write_file",
          arguments: {
            path: "settings.ts",
            content:
              'export const settings = { theme: "dark", STRIPE_SECRET_KEY: "sk_live_abcdefghijklmnop1234" };\n',
          },
        },
      ],
    },
    { content: "Added a settings field." },
  ]),
);

const result = spawnSync(
  process.execPath,
  [
    resolve("src/index.ts"),
    "--provider", "mock",
    "--permission", "full",
    "--canary", "auto",
    "--workspace", scratch,
    "--script", script,
    "-p", "add a settings field",
  ],
  { encoding: "utf8", env: { ...process.env, WEAVER_HOME: join(scratch, ".weaver") } },
);

process.stdout.write(result.stdout ?? "");
if (result.stderr) process.stderr.write(result.stderr);

rmSync(scratch, { recursive: true, force: true });

if ((result.stdout ?? "").includes("BLOCKED")) {
  console.log("CANARY SMOKE PASS: the critical change was blocked without a signed approval.");
  process.exit(0);
}
console.error("CANARY SMOKE FAIL: expected a BLOCKED verdict from the sign-off.");
process.exit(1);
