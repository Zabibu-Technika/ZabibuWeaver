// Visual primitives.
//
// The only contract that matters is that the decoration never changes the visible width.
import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth, stripAnsi } from "./ansi.ts";
import { badge, bar, gradient } from "./theme.ts";

test("a gradient keeps the text and colours each character", () => {
  const painted = gradient("arif");
  assert.equal(stripAnsi(painted), "arif");
  assert.match(painted, /\u001b\[38;2;/);
  assert.equal(displayWidth(painted), 4);
});

test("a badge is the label plus one cell of padding on each side", () => {
  const painted = badge("proved", "ok");
  assert.equal(stripAnsi(painted), " proved ");
  assert.equal(displayWidth(painted), 8);
  assert.match(painted, /\u001b\[48;2;/);
});

test("a bar is exactly its width, whatever the value", () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [0.5, 5],
    [1, 10],
    [2, 10],
    [-1, 0],
  ];
  for (const [fraction, filled] of cases) {
    const painted = bar(fraction, 10);
    assert.equal(displayWidth(painted), 10, `width for ${fraction}`);
    assert.equal(stripAnsi(painted), `${"█".repeat(filled)}${"░".repeat(10 - filled)}`);
  }
  assert.equal(bar(0.5, 0), "");
});
