// Styled spans.
//
// The contract: wrapping and truncation never lose a style, and never exceed the width.
import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth } from "./ansi.ts";
import { segmentsText, truncateSegments, wrapSegments } from "./rich.ts";

test("styles survive a line break", () => {
  const lines = wrapSegments(
    [
      { text: "const ", style: "keyword" },
      { text: "answer", style: "code" },
      { text: " = 42", style: "number" },
    ],
    10,
  );

  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(displayWidth(segmentsText(line)) <= 10);
  assert.equal(lines[0]?.[0]?.style, "keyword", "the keyword must stay a keyword on line one");
  assert.equal(lines.at(-1)?.at(-1)?.style, "number", "the number must keep its colour");
});

test("truncation cuts by visible width, not string length", () => {
  assert.equal(segmentsText(truncateSegments([{ text: "abcdef", style: "code" }], 4)), "abcd");
});

test("a wide character is never split in half", () => {
  // Two CJK glyphs are four cells; a three-cell budget fits exactly one.
  assert.equal(segmentsText(truncateSegments([{ text: "世界", style: "code" }], 3)), "世");
});
