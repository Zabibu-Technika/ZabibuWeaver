// The sign-off's failure modes.
//
// The property under test is simple and load-bearing: **an unjudgeable change is
// never a clean one.** A gate that silently stops working is worse than no gate,
// because people stop checking whether it is on.
//
// Three ways the judge can fail, all of which must come back `blocked` with a
// reason attached rather than as an exception or, worse, as nothing at all:
//   1. an explicit override that points somewhere unusable,
//   2. a judge that loads and then throws while analysing,
//   3. the judge that is always there when nothing is wrong (control case).
//
// Then, below, the fix-verify loop: what the agent does when the judge blocks it.
// Those need a scripted model, and they live here because they need the same
// shared repository — `git init` costs about 2.3 seconds on this machine, and
// every fixture is one more of them.
//
// One repository is shared by all four tests. Not for tidiness: `git init` costs
// roughly 2.3 seconds on this machine and 1.9 seconds per config call, so four
// independent fixtures would add half a minute to `npm test` for no additional
// coverage. Nothing in these tests mutates the repo — they only read its diff.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadConfig } from "../config.ts";
import { runTurn, newAgentState, type AgentDeps, type AgentEvent } from "../core/agent.ts";
import type { ChatMessage } from "../core/types.ts";
import { allTools } from "../tools/index.ts";
import { createMockProvider } from "../providers/mock.ts";
import { analysisIdFor, reportOrigin, reviewWorkspace, type CanaryReport } from "./canary.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * A real repository with a real change: one tracked file, committed, then edited
 * with a hardcoded credential. `git diff` is non-empty, so the sign-off has
 * something to judge.
 *
 * The credential must be named something the judge recognises — its patterns look
 * for identifiers containing `secret`, `password`, `token`, `api_key`,
 * `access_key` or `private_key`, or for literal `sk-…`/`ghp_…` values. A bare
 * `KEY:` does not trip it, which is worth knowing: an assertion that the judge
 * found something is only as good as the fixture.
 */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "weaver-canary-test-"));
  writeFileSync(join(dir, "settings.ts"), 'export const settings = { theme: "dark" };\n');
  git(dir, "init");
  git(dir, "add", "settings.ts");
  // One `-c` pair instead of two `git config` calls: each costs ~1.9s here.
  git(
    dir,
    "-c", "user.email=test@weaver.local",
    "-c", "user.name=Weaver Test",
    "commit", "-m", "init",
  );
  writeFileSync(
    join(dir, "settings.ts"),
    'export const settings = { theme: "dark", API_TOKEN: "sk_live_abcdefghijklmnop1234" };\n',
  );
  return dir;
}

let repo: string;
let engineDir: string;

before(() => {
  repo = scratchRepo();
  engineDir = mkdtempSync(join(tmpdir(), "weaver-canary-engines-"));
});

after(() => {
  for (const dir of [repo, engineDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort; it must not fail the suite.
    }
  }
});

const ENV_KEYS = ["WEAVER_HOME", "WEAVER_CANARY_ENGINE", "WEAVER_CANARY", "WEAVER_CANARY_REPAIR"] as const;

/** Run with an isolated home, no engine override, and Canary enabled. */
async function isolated<T>(body: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "weaver-canary-home-"));
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.WEAVER_HOME = home;
  delete process.env.WEAVER_CANARY_ENGINE;
  delete process.env.WEAVER_CANARY;

  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("a real change is judged — and the analysisId matches sha256(diff)", async () => {
  await isolated(async () => {
    const cfg = loadConfig({ workspace: repo, provider: "mock" });
    const report = await reviewWorkspace(cfg);

    assert.ok(report !== null, "expected a report for a non-empty diff");
    assert.equal(report.judgeError, undefined, "the judge must not have failed");
    assert.equal(report.source, "embedded");
    assert.equal(reportOrigin(report).slice(0, 8), "embedded");

    // The judge saw a hardcoded credential and said no, without being asked.
    assert.equal(report.blocked, true, "a critical finding with no approval must block");
    assert.equal(report.approved, false);
    assert.ok(report.findings.length > 0, "expected at least one finding");

    // This is the contract with the Canary CLI: the id must be sha256(diff),
    // truncated to 16 hex chars, or receipts stop matching across tools.
    const diff = git(repo, "diff");
    assert.equal(report.analysisId, analysisIdFor(diff));
    assert.equal(report.analysisId.length, 16);
  });
});

test("an unusable judge override fails CLOSED, with a reason", async () => {
  await isolated(async () => {
    process.env.WEAVER_CANARY_ENGINE = join(engineDir, "nowhere.ts");
    const cfg = loadConfig({ workspace: repo, provider: "mock" });
    const report = await reviewWorkspace(cfg);

    assert.ok(report !== null);
    assert.equal(report.blocked, true, "an unjudgeable change must never pass");
    assert.equal(report.approved, false);
    assert.equal(report.source, "override", "it must say which judge was requested");
    assert.match(report.judgeError ?? "", /could not be loaded/);
    assert.match(report.judgeError ?? "", /nowhere\.ts/, "the message must name the bad path");
    assert.equal(report.findings.length, 0, "findings must not be invented for an unrun judge");
    assert.equal(report.riskScore, 0, "a score never computed must not be shown as a clean 0");
    assert.match(reportOrigin(report), /override/);
  });
});

test("a judge that throws while analysing fails CLOSED, with the error", async () => {
  await isolated(async () => {
    // Loads cleanly (so it passes the override's shape check), then explodes.
    const broken = join(engineDir, "broken-engine.ts");
    writeFileSync(
      broken,
      [
        'export function analyzeContent(): never { throw new Error("boom in the judge"); }',
        'export function verdictFor() { return { label: "—" }; }',
        "export function sectorImpacts() { return {}; }",
        "",
      ].join("\n"),
    );

    process.env.WEAVER_CANARY_ENGINE = broken;
    const cfg = loadConfig({ workspace: repo, provider: "mock" });
    const report = await reviewWorkspace(cfg);

    assert.ok(report !== null);
    assert.equal(report.blocked, true, "a judge that throws must not be read as a pass");
    assert.equal(report.approved, false);
    assert.match(report.judgeError ?? "", /the judge threw/);
    assert.match(report.judgeError ?? "", /boom in the judge/, "the real error must reach the user");
    assert.equal(report.findings.length, 0);
  });
});

test("turning the sign-off off produces no report at all", async () => {
  await isolated(async () => {
    process.env.WEAVER_CANARY = "off";
    const cfg = loadConfig({ workspace: repo, provider: "mock" });
    const report = await reviewWorkspace(cfg);
    assert.equal(report, null, "Canary off means no report, not a failed one");
  });
});

// --- The fix-verify loop -----------------------------------------------------
//
// A blocked verdict is information, and the model that caused it is better placed
// to act on it than the human reading the output. So on a BLOCK the findings go
// back to the model for one bounded repair pass, and the judge runs again.
//
// What these tests are really checking is that the loop cannot approve anything.
// It runs the same judge against the new diff; only the ledger approves. The
// repair pass changes who does the copy-pasting, not who decides.

const SECRET_LINE = 'export const settings = { theme: "dark", API_TOKEN: "sk_live_abcdefghijklmnop1234" };';
const REPAIRED_LINE = 'export const settings = { theme: "dark", API_TOKEN: process.env.API_TOKEN };';

/** Runs a scripted turn end to end and returns the events it emitted. */
async function scriptedTurn(
  script: Array<Record<string, unknown>>,
  env: { repair?: string; engine?: string } = {},
): Promise<{ events: AgentEvent[]; messages: ChatMessage[] }> {
  const file = join(engineDir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));

  if (env.repair !== undefined) process.env.WEAVER_CANARY_REPAIR = env.repair;
  else delete process.env.WEAVER_CANARY_REPAIR;
  if (env.engine !== undefined) process.env.WEAVER_CANARY_ENGINE = env.engine;
  else delete process.env.WEAVER_CANARY_ENGINE;

  const config = loadConfig({ workspace: repo, provider: "mock", permission: "full" });
  const events: AgentEvent[] = [];
  const deps: AgentDeps = {
    config,
    provider: createMockProvider(file),
    tools: allTools,
    confirm: async () => "yes",
    emit: (event) => events.push(event),
  };
  const state = newAgentState();
  await runTurn(deps, state, "add a token to the settings");
  return { events, messages: state.messages };
}

function canaries(events: AgentEvent[]): CanaryReport[] {
  return events.flatMap((event) => (event.type === "canary" ? [event.report] : []));
}

function notices(events: AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === "notice" ? [event.text] : []));
}

function repairBriefs(messages: ChatMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === "user" && (message.content ?? "").includes("BLOCKED") ? [message.content ?? ""] : [],
  );
}

test("a blocked sign-off hands the findings back and re-judges the repair", async () => {
  await isolated(async () => {
    const { events, messages } = await scriptedTurn([
      { toolCalls: [{ name: "write_file", arguments: { path: "settings.ts", content: `${SECRET_LINE}\n` } }] },
      // A turn with no tool calls ends the loop, which is what lets the judge run.
      { content: "added the token" },
      { toolCalls: [{ name: "write_file", arguments: { path: "settings.ts", content: `${REPAIRED_LINE}\n` } }] },
      { content: "swapped the literal for an environment lookup" },
    ]);

    const reports = canaries(events);
    assert.equal(reports.length, 2, "the judge must run once, then again after the repair");
    assert.equal(reports[0]?.blocked, true, "the first verdict must block the hardcoded credential");
    assert.equal(reports[1]?.blocked, false, "the repaired change must pass");
    assert.notEqual(reports[0]?.analysisId, reports[1]?.analysisId, "the diff changed, so the id must too");

    assert.ok(notices(events).some((text) => /repair pass 1\/1/.test(text)), "the repair pass must be announced");
    assert.ok(notices(events).some((text) => /cleared after 1 repair pass/.test(text)), "the recovery must be announced");

    const brief = repairBriefs(messages)[0] ?? "";
    assert.match(brief, /Do NOT attempt to approve, sign, or record this change/, "the model must be told it cannot self-approve");
    assert.match(brief, /Do NOT delete, disable, or neuter/, "the model must be told that silencing the check is not a fix");
    assert.match(brief, /false positive/, "a false positive must be raised, not routed around");
    assert.match(brief, /repair pass 1 of 1/i, "the model must know its budget");

    assert.equal(events.at(-1)?.type, "turn-end");
  });
});

test("repair can be switched off, and then the turn simply stops blocked", async () => {
  await isolated(async () => {
    const { events, messages } = await scriptedTurn(
      [{ toolCalls: [{ name: "write_file", arguments: { path: "settings.ts", content: `${SECRET_LINE}\n` } }] }, { content: "done" }],
      { repair: "0" },
    );

    const reports = canaries(events);
    assert.equal(reports.length, 1, "no re-judge without a repair pass");
    assert.equal(reports[0]?.blocked, true);
    assert.equal(notices(events).some((text) => /repair pass/.test(text)), false, "nothing should offer to repair");
    assert.equal(repairBriefs(messages).length, 0, "no repair brief should be sent");
  });
});

test("a repair that changes nothing stops the loop instead of asking twice", async () => {
  await isolated(async () => {
    const { events } = await scriptedTurn([
      { toolCalls: [{ name: "write_file", arguments: { path: "settings.ts", content: `${SECRET_LINE}\n` } }] },
      { content: "I looked at it and it seems fine to me" },
    ]);

    const reports = canaries(events);
    assert.equal(reports.length, 2, "the judge still re-runs, so the verdict is never assumed");
    assert.equal(reports[0]?.analysisId, reports[1]?.analysisId, "an unchanged diff must produce the same id");
    assert.equal(reports[1]?.blocked, true);
    assert.ok(notices(events).some((text) => /changed nothing/.test(text)), "the stale verdict must be explained");
    assert.equal(notices(events).some((text) => /cleared after/.test(text)), false);
  });
});

test("a failing judge is never handed to the model for repair", async () => {
  await isolated(async () => {
    const { events, messages } = await scriptedTurn(
      [{ toolCalls: [{ name: "write_file", arguments: { path: "settings.ts", content: `${SECRET_LINE}\n` } }] }, { content: "done" }],
      { engine: join(engineDir, "nowhere.ts") },
    );

    const reports = canaries(events);
    assert.equal(reports.length, 1, "the model must not be asked to repair a gate that never ran");
    assert.notEqual(reports[0]?.judgeError, undefined);
    assert.equal(notices(events).some((text) => /repair pass/.test(text)), false);
    assert.equal(repairBriefs(messages).length, 0);
  });
});
