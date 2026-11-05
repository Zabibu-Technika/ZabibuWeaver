// Compaction, wired end to end.
//
// The unit tests cover the split and the estimate; this one covers the part that fails
// in production rather than in a test harness — that the loop actually notices it is
// running out of room, summarizes, and keeps going, without a real provider.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { newAgentState, runTurn, type AgentDeps, type AgentEvent } from "./agent.ts";
import { allTools } from "../tools/index.ts";
import type { AssistantTurn, ChatRequest, Provider } from "./types.ts";

/** Grows the conversation with edits, and answers the summarizer when it arrives. */
function growingProvider(steps: number): Provider {
  let step = 0;
  return {
    name: "growing",
    async chat(req: ChatRequest): Promise<AssistantTurn> {
      // The summarizer call is the one with no tools. Answer it like a summarizer.
      if (req.tools.length === 0) {
        return { content: "## Objective\nShip compaction.", toolCalls: [], raw: "", recovered: false };
      }
      step += 1;
      if (step <= steps) {
        const args = JSON.stringify({ path: `f${step}.ts`, content: "y".repeat(2_000) });
        return {
          content: "",
          toolCalls: [{ id: `c${step}`, type: "function", function: { name: "write_file", arguments: args } }],
          raw: "",
          recovered: false,
        };
      }
      return { content: "done", toolCalls: [], raw: "", recovered: false };
    },
  };
}

test("the loop compacts under a small window instead of dying at the limit", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "weaver-compact-ws-"));
  const home = mkdtempSync(join(tmpdir(), "weaver-compact-home-"));

  const saved: Record<string, string | undefined> = {
    WEAVER_HOME: process.env.WEAVER_HOME,
    WEAVER_CONTEXT: process.env.WEAVER_CONTEXT,
    WEAVER_COMPACT_KEEP: process.env.WEAVER_COMPACT_KEEP,
    WEAVER_COMPACT_BUFFER: process.env.WEAVER_COMPACT_BUFFER,
  };

  try {
    process.env.WEAVER_HOME = home;
    process.env.WEAVER_CONTEXT = "2000";
    process.env.WEAVER_COMPACT_KEEP = "300";
    process.env.WEAVER_COMPACT_BUFFER = "300";

    const config = loadConfig({ workspace, provider: "mock", permission: "full" });
    const events: AgentEvent[] = [];
    const deps: AgentDeps = {
      config,
      provider: growingProvider(6),
      tools: allTools,
      confirm: async () => "yes",
      emit: (event) => events.push(event),
    };

    const state = newAgentState();
    await runTurn(deps, state, "create several files");

    const compacted = events.filter((event) => event.type === "compacted");
    assert.ok(compacted.length >= 1, `expected at least one compaction, got ${compacted.length}`);
    const first = compacted[0];
    assert.ok(first !== undefined && first.type === "compacted");
    assert.ok(first.after < first.before, "compaction must shrink the estimate");
    assert.ok(first.removed > 0);

    // The head became a labelled summary, not the original first message.
    assert.equal(state.messages[0]?.role, "system");
    assert.match(String(state.messages[0]?.content), /Ship compaction/);

    // The work the loop was doing still finished.
    assert.ok(state.messages.some((message) => message.content === "done"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a too-long rejection triggers a single compact-and-retry", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "weaver-compact-ws-"));
  const home = mkdtempSync(join(tmpdir(), "weaver-compact-home-"));
  const saved: Record<string, string | undefined> = {
    WEAVER_HOME: process.env.WEAVER_HOME,
    WEAVER_CONTEXT: process.env.WEAVER_CONTEXT,
    WEAVER_COMPACT: process.env.WEAVER_COMPACT,
    WEAVER_COMPACT_KEEP: process.env.WEAVER_COMPACT_KEEP,
  };

  try {
    process.env.WEAVER_HOME = home;
    process.env.WEAVER_CONTEXT = "2000";
    // Auto-compaction off, so only the error-recovery path runs.
    process.env.WEAVER_COMPACT = "off";
    process.env.WEAVER_COMPACT_KEEP = "300";

    // Rejects the first real request as too long, then compacts and answers normally.
    let threw = false;
    let calls = 0;
    const provider: Provider = {
      name: "overflow",
      async chat(req: ChatRequest): Promise<AssistantTurn> {
        calls += 1;
        if (req.tools.length === 0) {
          return { content: "## Objective\nRecover.", toolCalls: [], raw: "", recovered: false };
        }
        if (!threw) {
          threw = true;
          throw new Error("maximum context length exceeded");
        }
        return { content: "recovered", toolCalls: [], raw: "", recovered: false };
      },
    };

    const config = loadConfig({ workspace, provider: "mock", permission: "full" });
    const events: AgentEvent[] = [];
    const deps: AgentDeps = {
      config,
      provider,
      tools: allTools,
      confirm: async () => "yes",
      emit: (event) => events.push(event),
    };
    const state = newAgentState();

    // A long history so compaction has something real to summarize away.
    for (let index = 0; index < 6; index += 1) {
      state.messages.push({ role: "user", content: `step ${index}: ${"x".repeat(300)}` });
      state.messages.push({ role: "assistant", content: `done ${index}: ${"x".repeat(300)}` });
    }

    await runTurn(deps, state, "do the thing");

    assert.ok(calls >= 3, `expected the retry to reach the model again, got ${calls} calls`);
    assert.ok(events.some((event) => event.type === "compacted"), "the recovery must compact");
    assert.ok(state.messages.some((message) => message.content === "recovered"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
