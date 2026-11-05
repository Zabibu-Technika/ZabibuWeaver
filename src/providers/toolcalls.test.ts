// Tests for the salvaged tool-call parser — the exact failure the old skeleton
// tried to handle by regexing Groq's error string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractToolCalls, parseArguments, readBalanced } from "./toolcalls.ts";

test("extracts a self-closing call with no arguments", () => {
  const calls = extractToolCalls("<function=list_project_files/>");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.function.name, "list_project_files");
  assert.equal(calls[0]?.function.arguments, "{}");
});

test("extracts nested json arguments intact", () => {
  const text = '<function=list_files {"kwargs": {"directory": "C:\\\\tmp"}}</function>';
  const calls = extractToolCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(parseArguments(calls[0]?.function.arguments), {
    kwargs: { directory: "C:\\tmp" },
  });
});

test("tolerates the [] artefact between name and arguments", () => {
  const text = '<function=create_new_folder[]{"folder_name":"final_test_folder"}</function>';
  const calls = extractToolCalls(text);
  assert.equal(calls[0]?.function.name, "create_new_folder");
  assert.deepEqual(parseArguments(calls[0]?.function.arguments), {
    folder_name: "final_test_folder",
  });
});

test("reads several calls from one blob", () => {
  const text = '<function=a/> and then <function=b {"x":1}></function>';
  const calls = extractToolCalls(text);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.function.name), ["a", "b"]);
});

test("readBalanced respects strings containing braces", () => {
  const text = '{"template": "a } b"}';
  const balanced = readBalanced(text, 0);
  assert.equal(balanced?.json, text);
});

test("parseArguments returns {} for empty input", () => {
  assert.deepEqual(parseArguments(""), {});
  assert.deepEqual(parseArguments(undefined), {});
});

test("parseArguments repairs trailing commas and single quotes", () => {
  assert.deepEqual(parseArguments("{'path': 'a.ts',}"), { path: "a.ts" });
});

test("parseArguments throws on hopeless input", () => {
  assert.throws(() => parseArguments("not json at all"));
});
