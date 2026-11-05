// The highlighter.
//
// It is a scanner, not a parser. These tests hold it to the parts that matter: the text is
// never changed, keywords/numbers/comments are recognisable, and JSON keys are not
// mistaken for values.
import assert from "node:assert/strict";
import test from "node:test";
import { highlight } from "./highlight.ts";
import { segmentsText } from "./rich.ts";

test("TypeScript keywords, numbers, and comments are distinguishable", () => {
  const line = "const answer = 42; // the answer";
  const segments = highlight(line, "ts");
  assert.equal(segmentsText(segments), line, "highlighting must not change the text");

  assert.equal(segments.find((segment) => segment.text === "const")?.style, "keyword");
  assert.equal(segments.find((segment) => segment.text === "42")?.style, "number");
  assert.equal(segments.find((segment) => segment.text.startsWith("//"))?.style, "comment");
});

test("a string is not treated as a comment marker", () => {
  const line = 'const url = "https://example.test";';
  const segments = highlight(line, "ts");
  assert.equal(segmentsText(segments), line);
  assert.equal(segments.find((segment) => segment.text.includes("https://"))?.style, "string");
  assert.equal(segments.find((segment) => segment.style === "comment"), undefined);
});

test("JSON keys are accented, values are strings", () => {
  const segments = highlight('{"name": "weaver", "n": 1}', "json");
  assert.equal(segments.find((segment) => segment.text === '"name"')?.style, "accent");
  assert.equal(segments.find((segment) => segment.text === '"weaver"')?.style, "string");
  assert.equal(segments.find((segment) => segment.text === "1")?.style, "number");
});

test("Python comments and keywords work too", () => {
  const segments = highlight("def run(): # start", "py");
  assert.equal(segments.find((segment) => segment.text === "def")?.style, "keyword");
  assert.equal(segments.find((segment) => segment.text.startsWith("#"))?.style, "comment");
});

test("an unknown language still returns the same text", () => {
  const segments = highlight("hello world", "brainfuck");
  assert.equal(segmentsText(segments), "hello world");
});
