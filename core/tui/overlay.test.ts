// Overlays.
//
// The invariant: composing an overlay never changes the frame's size, and the panel is
// centred and opaque. Everything else (palette, picker, confirmation) is content.
import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth } from "./ansi.ts";
import { overlay } from "./overlay.ts";

test("an overlay keeps the frame size and exact widths", () => {
  const base = Array.from({ length: 24 }, () => "x".repeat(80));
  const lines = overlay(base, {
    title: "switch account",
    rows: [{ text: "alice" }, { text: "bob" }],
    width: 80,
    height: 24,
  });

  assert.equal(lines.length, 24);
  for (const line of lines) assert.equal(displayWidth(line), 80);
  assert.match(lines.join("\n"), /switch account/);
  assert.match(lines.join("\n"), /alice/);
});

test("the background is dimmed outside the panel", () => {
  const base = Array.from({ length: 20 }, () => "x".repeat(60));
  const lines = overlay(base, { title: "help", rows: [{ text: "one" }], width: 60, height: 20 });
  assert.match(lines[0] ?? "", /\u001b\[2m/, "the top row should be dimmed");
  assert.doesNotMatch(lines[9] ?? "", /^\u001b\[2m/, "the panel row should not be dimmed");
});

test("a short terminal is handled without growing the frame", () => {
  const base = Array.from({ length: 10 }, () => "x".repeat(40));
  const lines = overlay(base, {
    title: "palette",
    rows: Array.from({ length: 12 }, (_, index) => ({ text: `item ${index}` })),
    width: 40,
    height: 10,
  });
  assert.equal(lines.length, 10);
  for (const line of lines) assert.equal(displayWidth(line), 40);
});
