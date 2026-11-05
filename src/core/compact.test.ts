// Compaction.
//
// Three properties matter and none of them is "the summary is good" — that needs a model
// and a judgement. What is testable here is the plumbing that must not break:
//   1. a split never orphans a tool result, because providers reject that conversation;
//   2. the language-tax estimate charges non-Latin text more, because a budget that
//      assumes English silently starves everyone else;
//   3. a summarizer failure degrades honestly instead of killing the turn.
import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, Provider } from "./types.ts";
import {
  compact,
  estimateMessages,
  estimateSchemas,
  estimateTokens,
  shouldCompact,
  splitPoint,
  SUMMARY_MARKER,
  type CompactSettings,
} from "./compact.ts";

const SETTINGS: CompactSettings = { contextWindow: 8_000, keep: 400, buffer: 1_000 };

function summarizer(text = "## Objective\nShip the undo surface."): Provider {
  return {
    name: "fake-summarizer",
    async chat() {
      return { content: text, toolCalls: [], raw: text, recovered: false };
    },
  };
}

function failing(): Provider {
  return {
    name: "failing",
    async chat() {
      throw new Error("summarizer unavailable");
    },
  };
}

/** A conversation of alternating turns, long enough to exceed the keep budget. */
function longConversation(turns = 6): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: "user", content: `task ${index}: ${"detail ".repeat(60)}` });
    messages.push({ role: "assistant", content: `answer ${index}: ${"work ".repeat(60)}` });
  }
  return messages;
}

test("the estimator charges non-Latin scripts more, because the tokenizer does", () => {
  // 100 characters of each. If these were equal, an Amharic session would consume its
  // context window roughly seven times faster than the budget predicted.
  const latin = "a".repeat(100);
  const amharic = "ሰ".repeat(100);
  const nko = "ߊ".repeat(100);

  assert.ok(estimateTokens(amharic) > estimateTokens(latin) * 3, "Amharic must cost more than Latin");
  assert.ok(estimateTokens(nko) > estimateTokens(latin) * 3, "N'Ko must cost more than Latin");
  assert.equal(estimateTokens(latin), 25, "ASCII is still chars/4");
});

test("empty text costs nothing and schemas are counted", () => {
  assert.equal(estimateTokens(""), 0);
  const schemas = [
    { type: "function" as const, function: { name: "run_shell", description: "Run a command", parameters: { type: "object" } } },
  ];
  assert.ok(estimateSchemas(schemas) > 10, "tool definitions are billed on every request");
});

test("compaction is triggered by the window minus the buffer", () => {
  const messages = longConversation(20);
  const small: CompactSettings = { contextWindow: 4_000, keep: 500, buffer: 500 };
  assert.equal(shouldCompact(messages, SETTINGS), false);
  assert.equal(shouldCompact(messages, small), true);
  // Fixed overhead — the system prompt and schemas — counts toward the same budget.
  assert.equal(shouldCompact(messages, SETTINGS, 7_000), true);
});

test("the tail never begins with a tool result", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "start" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", name: "read_file", content: "x".repeat(4_000) },
    { role: "assistant", content: "done" },
    { role: "user", content: "next" },
    { role: "assistant", content: "ok" },
  ];

  const index = splitPoint(messages, 100);
  assert.ok(index > 0);
  assert.notEqual(messages[index]?.role, "tool", "a tool result must not open the tail");
});

test("a single user prompt with many tool turns can still be compacted", () => {
  // The normal shape of an agentic task: one instruction, then a long run of
  // assistant/tool pairs with no further user turns. Requiring a user boundary here
  // would mean such a task can never be compacted.
  const messages: ChatMessage[] = [{ role: "user", content: "do the big task" }];
  for (let i = 0; i < 8; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "write_file", arguments: `{"path":"f${i}.ts"}` } }],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, name: "write_file", content: "y".repeat(2_000) });
  }

  const index = splitPoint(messages, 300);
  assert.ok(index > 0, "a multi-step task must be splittable");
  assert.notEqual(messages[index]?.role, "tool");
  assert.ok(index < messages.length - 1);
});

test("something that already fits is not compacted", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  assert.equal(splitPoint(messages, 10_000), 0);
});

test("compaction keeps the recent tail and replaces the head with a summary", async () => {
  const messages = longConversation(6);
  const tailContent = messages[messages.length - 2]?.content;

  const result = await compact(messages, summarizer(), SETTINGS, { model: "fake" });
  assert.ok(result !== null);

  assert.ok(result.removed > 0);
  assert.ok(result.after < result.before, "compaction must reduce the estimate");
  assert.equal(result.messages[0]?.role, "system");
  assert.match(String(result.messages[0]?.content), /Ship the undo surface/);
  assert.match(String(result.messages[0]?.content), new RegExp(SUMMARY_MARKER.replace(/[[\]]/g, "\\$&")));

  // The most recent work survives verbatim.
  const tail = result.messages.slice(1);
  assert.equal(tail.at(-2)?.content, tailContent, "the last user turn must survive intact");
  assert.ok(tail.every((message) => message.role !== "system"));
});

test("the summary is labelled as untrusted background, not as an instruction", async () => {
  const result = await compact(longConversation(4), summarizer(), SETTINGS, { model: "fake" });
  assert.ok(result !== null);
  const content = String(result.messages[0]?.content);
  assert.match(content, /not an instruction/i);
  assert.match(content, /untrusted/i);
});

test("a summarizer failure degrades honestly instead of failing the turn", async () => {
  const result = await compact(longConversation(4), failing(), SETTINGS, { model: "fake" });
  assert.ok(result !== null, "compaction must still return a usable conversation");
  assert.equal(result.degraded, true);
  assert.match(result.summary, /not recoverable/);
  assert.match(result.summary, /Ask the human/);
  assert.ok(result.messages.length > 1);
});

test("nothing is compacted when there is no safe split", async () => {
  // One giant user message: there is no earlier user boundary to split at, and dropping
  // the only user turn would delete the task itself.
  const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(20_000) }];
  assert.equal(await compact(messages, summarizer(), SETTINGS, { model: "fake" }), null);
});

test("the estimator sums messages, including tool call arguments", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "a".repeat(400) },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: "b".repeat(400) } }],
    },
  ];
  const total = estimateMessages(messages);
  assert.ok(total >= 200, `expected at least 200 estimated tokens, got ${total}`);
});
