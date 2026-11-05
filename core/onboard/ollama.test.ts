// Ollama output parsing.
import assert from "node:assert/strict";
import test from "node:test";
import { parseOllamaList } from "./ollama.ts";

test("the model column is parsed and the header is skipped", () => {
  const table = [
    "NAME                    ID              SIZE      MODIFIED",
    "qwen2.5-coder:7b        abc123          4.7 GB    2 days ago",
    "llama3:8b               def456          4.7 GB    1 week ago",
    "",
  ].join("\n");
  assert.deepEqual(parseOllamaList(table), ["qwen2.5-coder:7b", "llama3:8b"]);
});

test("an empty listing and a header-only listing both return nothing", () => {
  assert.deepEqual(parseOllamaList(""), []);
  assert.deepEqual(parseOllamaList("NAME ID SIZE MODIFIED"), []);
});
