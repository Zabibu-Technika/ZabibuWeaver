// Verification and proof, through the real turn loop.
//
// The unit tests prove the checker and the receipt separately. This proves they are
// actually called: a mutating turn runs the project's checks and leaves a receipt with a
// status a human can act on.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { newAgentState, runTurn, type AgentDeps, type AgentEvent } from "./agent.ts";
import { allTools } from "../tools/index.ts";
import type { AssistantTurn, ChatRequest, Provider } from "./types.ts";

/** Writes one file, then answers with prose so the loop ends. */
function writer(path: string): Provider {
  let step = 0;
  return {
    name: "writer",
    async chat(request: ChatRequest): Promise<AssistantTurn> {
      if (request.tools.length === 0) {
        return { content: "summary", toolCalls: [], raw: "", recovered: false };
      }
      step += 1;
      if (step === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path, content: "export const x = 1;\n" }),
              },
            },
          ],
          raw: "",
          recovered: false,
        };
      }
      return { content: "done", toolCalls: [], raw: "", recovered: false };
    },
  };
}

interface Outcome {
  events: AgentEvent[];
  dir: string;
}

async function turnWith(path: string): Promise<Outcome> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-verify-agent-"));
  const home = await mkdtemp(join(tmpdir(), "weaver-verify-home-"));
  const previousHome = process.env.WEAVER_HOME;
  process.env.WEAVER_HOME = home;

  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: 'node -e "process.exit(0)"' } }),
      "utf8",
    );

    const config = loadConfig({ workspace: dir, provider: "mock", permission: "full" });
    const events: AgentEvent[] = [];
    const deps: AgentDeps = {
      config,
      provider: writer(path),
      tools: allTools,
      confirm: async () => "yes",
      emit: (event) => events.push(event),
    };

    await runTurn(deps, newAgentState(), "make a change");
    return { events, dir };
  } finally {
    if (previousHome === undefined) delete process.env.WEAVER_HOME;
    else process.env.WEAVER_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

async function receiptFor(events: AgentEvent[]): Promise<{ status: string; selfAuthored: boolean; checks: unknown[] }> {
  const proof = events.find((event) => event.type === "proof");
  assert.ok(proof !== undefined && proof.type === "proof", "a mutating turn must emit a proof event");
  const json = proof.path.replace(/\.md$/, ".json");
  return JSON.parse(await readFile(json, "utf8")) as { status: string; selfAuthored: boolean; checks: unknown[] };
}

test("a mutating turn runs the checks and writes a proved receipt", async () => {
  const { events, dir } = await turnWith("src/app.ts");
  try {
    const verify = events.find((event) => event.type === "verify");
    assert.ok(verify !== undefined && verify.type === "verify");
    assert.equal(verify.ok, true, "the project's checks should have passed");

    const receipt = await receiptFor(events);
    assert.equal(receipt.status, "proved");
    assert.equal(receipt.selfAuthored, false);
    assert.equal(receipt.checks.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a turn that edits a test cannot claim independent proof", async () => {
  const { events, dir } = await turnWith("src/app.test.ts");
  try {
    const receipt = await receiptFor(events);
    assert.equal(receipt.status, "partial", "the turn changed the thing that judged it");
    assert.equal(receipt.selfAuthored, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
