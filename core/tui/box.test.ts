// Layout primitives.
//
// The only property that matters is exact visible width. Everything else — borders,
// alignment, the selection bar — is decoration on top of that.
import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth } from "./ansi.ts";
import { fit, joinColumns, panel, rule, splitWidth } from "./box.ts";

test("fit pads and truncates to an exact visible width", () => {
  assert.equal(fit("abc", 5), "abc  ");
  assert.equal(fit("abcdef", 4), "abcd");
  assert.equal(displayWidth(fit("abc", 5)), 5);
});

test("fit respects wide characters", () => {
  // Each CJK glyph is two cells. Padding by string length would be two cells short.
  const line = fit("世界", 6);
  assert.equal(displayWidth(line), 6);
  assert.equal(line, "世界  ");
  assert.equal(displayWidth(fit("世界abc", 5)), 5, "a wide glyph may be dropped, never split");
});

test("an empty width is empty, not a crash", () => {
  assert.equal(fit("anything", 0), "");
  assert.equal(rule(0), "");
});

test("a panel is exactly the requested size on every row", () => {
  const lines = panel({
    title: "growth",
    right: "3 queued",
    rows: [
      { text: "first line" },
      { text: "second line", style: "\u001b[36m" },
    ],
    width: 40,
    height: 8,
  });

  assert.equal(lines.length, 8);
  for (const line of lines) assert.equal(displayWidth(line), 40, `bad width: ${JSON.stringify(line)}`);
  assert.ok(lines[0]?.startsWith("╭"));
  assert.ok(lines.at(-1)?.startsWith("╰"));
  assert.ok(lines[0]?.includes("growth"));
  assert.ok(lines[0]?.includes("3 queued"));
});

test("a panel clips content rather than growing a row", () => {
  const lines = panel({
    rows: [{ text: "x".repeat(100) }],
    width: 20,
    height: 3,
  });
  assert.equal(lines.length, 3);
  for (const line of lines) assert.equal(displayWidth(line), 20);
});

test("a panel fills missing rows with blanks so the bottom border stays put", () => {
  const lines = panel({ rows: [{ text: "only" }], width: 12, height: 5 });
  assert.equal(lines.length, 5);
  assert.equal(displayWidth(lines[3] ?? ""), 12);
  assert.ok((lines[3] ?? "").includes("│"));
});

test("two panels join to the full width", () => {
  const left = panel({ rows: [], width: 20, height: 4 });
  const right = panel({ rows: [], width: 39, height: 4 });
  const joined = joinColumns(left, right, 20, 1);
  for (const line of joined) assert.equal(displayWidth(line), 60);
});

test("splitWidth never returns a negative column", () => {
  assert.deepEqual(splitWidth(80, 24), { left: 24, right: 55 });
  assert.deepEqual(splitWidth(10, 100), { left: 9, right: 0 });
  assert.deepEqual(splitWidth(0, 20), { left: 0, right: 0 });
});
