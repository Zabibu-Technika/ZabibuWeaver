// Proof of state — an agent may not claim "done" without running the project's checks.
//
// The failure this exists for is mundane and constant: a model writes code, says it is
// finished, and the tests fail. Not because the model lied — because it never looked.
// Asking it to "please verify" is a prompt, and a prompt is not a control. Running the
// project's own check commands and reading their exit codes is.
//
// WHAT WE WILL AND WILL NOT RUN
//
// Detection reads the project's manifest (package.json scripts, Cargo.toml, go.mod) and
// constructs a fixed command from a *script name*. The model never supplies a command
// here. That matters: a verification gate that executes model-authored strings is just a
// shell tool with better branding.
//
// Note the residual risk, stated rather than hidden: `npm run test` also runs the
// project's `pretest`/`posttest` scripts, which could do anything the user account can.
// That is the same trust the user already extends by running the project themselves, and
// the Canary gate is what judges a change to those scripts.
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type CheckKind = "typecheck" | "test" | "lint" | "build";

export interface Check {
  /** Short label, e.g. "typecheck". */
  name: string;
  kind: CheckKind;
  command: string;
  /** Where the command came from, so a surprising check can be explained. */
  source: string;
}

export interface CheckResult extends Check {
  ok: boolean;
  /** Exit code, or null when the process was killed. */
  code: number | null;
  ms: number;
  timedOut: boolean;
  output: string;
}

export interface VerificationReport {
  ok: boolean;
  checks: CheckResult[];
  /** Checks that were not run, and why. Silence here would read as a pass. */
  skipped: Array<{ name: string; reason: string }>;
  ms: number;
}

const MAX_OUTPUT = 8_000;
const DEFAULT_TIMEOUT_MS = 120_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface PackageJson {
  scripts?: Record<string, string>;
}

/** The package manager is whichever lockfile is present; npm when none is. */
async function packageManager(workspace: string): Promise<string> {
  if (await exists(join(workspace, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(workspace, "yarn.lock"))) return "yarn";
  if (await exists(join(workspace, "bun.lockb"))) return "bun";
  return "npm";
}

const SCRIPT_ALIASES: Array<{ kind: CheckKind; names: string[] }> = [
  { kind: "typecheck", names: ["typecheck", "type-check", "types", "tsc"] },
  { kind: "test", names: ["test", "tests", "test:unit"] },
  { kind: "lint", names: ["lint", "check"] },
  { kind: "build", names: ["build", "compile"] },
];

/**
 * What can be verified here.
 *
 * Ordered cheapest-first: a type error is caught in seconds and makes the test run
 * pointless, so it is worth reporting first even when both are run.
 */
export async function detectChecks(workspace: string): Promise<Check[]> {
  const root = resolve(workspace);
  const checks: Check[] = [];

  const pkgPath = join(root, "package.json");
  if (await exists(pkgPath)) {
    let pkg: PackageJson = {};
    try {
      pkg = JSON.parse(await readFile(pkgPath, "utf8")) as PackageJson;
    } catch {
      // A malformed manifest is not a reason to skip verification silently; the
      // typecheck fallback below may still work.
    }
    const scripts = pkg.scripts ?? {};
    const manager = await packageManager(root);

    for (const { kind, names } of SCRIPT_ALIASES) {
      const found = names.find((name) => typeof scripts[name] === "string" && scripts[name].trim().length > 0);
      if (found !== undefined) {
        checks.push({
          name: found,
          kind,
          command: kind === "test" ? `${manager} test` : `${manager} run ${found}`,
          source: "package.json scripts",
        });
      }
    }

    // No typecheck script, but the project has TypeScript and its compiler installed.
    if (!checks.some((check) => check.kind === "typecheck") && (await exists(join(root, "tsconfig.json")))) {
      if (await exists(join(root, "node_modules", "typescript", "bin", "tsc"))) {
        checks.push({
          name: "typecheck (tsc)",
          kind: "typecheck",
          command: "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit",
          source: "tsconfig.json + installed tsc",
        });
      }
    }
  }

  if (await exists(join(root, "Cargo.toml"))) {
    checks.push({ name: "cargo test", kind: "test", command: "cargo test --quiet", source: "Cargo.toml" });
  }
  if (await exists(join(root, "go.mod"))) {
    checks.push({ name: "go test", kind: "test", command: "go test ./...", source: "go.mod" });
  }

  // Deduplicate by command: a project with both a `test` script and a test runner
  // config should not run the same suite twice.
  const seen = new Set<string>();
  return checks.filter((check) => {
    if (seen.has(check.command)) return false;
    seen.add(check.command);
    return true;
  });
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${text.length - limit} more characters]`;
}

function runOne(workspace: string, check: Check, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;

    // On POSIX, spawn into its own process group so a timeout can kill the whole tree.
    // Windows has no equivalent flag; taskkill /t does the same job there.
    const child = spawn(check.command, {
      cwd: workspace,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    // A shell spawns grandchildren. Killing the shell is not enough on Windows, where a
    // hung `npm test` would keep running after its parent died — on an edge device that
    // is a fan spinning until the battery is flat.
    const killTree = (): void => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        } catch {
          // Fall through to the direct kill.
        }
        child.kill();
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const append = (chunk: Buffer): void => {
      if (output.length >= MAX_OUTPUT) return;
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ...check,
        ok: code === 0 && !timedOut,
        code,
        ms: Date.now() - started,
        timedOut,
        output: clip(output.trim(), MAX_OUTPUT),
      });
    };

    child.on("error", (error) => {
      append(Buffer.from(`\n${error.message}`));
      finish(null);
    });
    child.on("close", finish);
  });
}

export interface RunOptions {
  timeoutMs?: number;
  /** Stop at the first failure. Cheaper, and the later checks rarely add information. */
  stopOnFailure?: boolean;
}

/**
 * Run the checks and report what actually happened.
 *
 * A check that could not be run is listed in `skipped`, never dropped. An empty report
 * with no explanation is indistinguishable from a clean one, which is the exact
 * ambiguity this module exists to remove.
 */
export async function runChecks(
  workspace: string,
  checks: Check[],
  options: RunOptions = {},
): Promise<VerificationReport> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: CheckResult[] = [];
  const skipped: VerificationReport["skipped"] = [];

  for (const check of checks) {
    if (results.length >= 20) {
      skipped.push({ name: "remaining checks", reason: "bounded to 20 checks per run" });
      break;
    }
    if (options.stopOnFailure !== false && results.some((result) => !result.ok)) {
      skipped.push({ name: check.name, reason: "not run — an earlier check failed" });
      continue;
    }
    results.push(await runOne(workspace, check, timeoutMs));
  }

  return {
    ok: results.length > 0 && results.every((result) => result.ok),
    checks: results,
    skipped,
    ms: Date.now() - started,
  };
}

/** One-line-per-check summary for the UI and for a repair prompt. */
export function summarize(report: VerificationReport): string {
  if (report.checks.length === 0 && report.skipped.length === 0) {
    return "No verification checks were detected, so nothing was proven about this change.";
  }
  const lines = report.checks.map(
    (check) =>
      `${check.ok ? "PASS" : check.timedOut ? "TIMEOUT" : "FAIL"} ${check.name} (${check.ms}ms)` +
      (check.ok ? "" : `\n  command: ${check.command}\n  ${check.output.split("\n").slice(-8).join("\n  ")}`),
  );
  for (const skip of report.skipped) lines.push(`SKIPPED ${skip.name} — ${skip.reason}`);
  return lines.join("\n");
}
