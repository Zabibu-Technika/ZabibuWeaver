import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { runSubagent } from "./agent.ts";
import { allTools } from "../tools/index.ts";
import type { AssistantTurn, ChatRequest, Delta, Provider } from "./types.ts";

function fakeProvider(turns: AssistantTurn[]): Provider {
  let index = 0;
  return {
    name: "fake",
    async chat(_request: ChatRequest, onDelta: (delta: Delta) => void): Promise<AssistantTurn> {
      const turn = turns[Math.min(index, turns.length - 1)]!;
      index += 1;
      if (turn.content) onDelta({ content: turn.content });
      return turn;
    },
  };
}

test("a subagent gets a fresh, read-only context and returns its summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weaver-subagent-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export const answer = 42;\n", "utf8");

    const provider = fakeProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/app.ts" }) },
          },
        ],
        raw: "",
        recovered: false,
      },
      {
        content: "The answer is 42 in src/app.ts.",
        toolCalls: [],
        raw: "",
        recovered: false,
      },
    ]);

    const config = loadConfig({ workspace: dir, provider: "mock", permission: "readonly" });
    const result = await runSubagent(
      { config, provider, tools: allTools, confirm: async () => "no", emit: () => {} },
      "What is the answer?",
      { role: "research", maxSteps: 3 },
    );

    assert.equal(result.toolCalls, 1);
    assert.match(result.text, /answer is 42/);
    assert.ok(result.steps >= 3, "the child should have user, tool, and assistant messages");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a subagent without a final answer reports no text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weaver-subagent-empty-"));
  try {
    const provider = fakeProvider([
      { content: "", toolCalls: [], raw: "", recovered: false },
    ]);
    const config = loadConfig({ workspace: dir, provider: "mock", permission: "readonly" });
    const result = await runSubagent(
      { config, provider, tools: allTools, confirm: async () => "no", emit: () => {} },
      "Say nothing.",
      { maxSteps: 1 },
    );
    assert.equal(result.text, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
