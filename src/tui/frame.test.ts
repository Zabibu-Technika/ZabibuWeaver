// Tests for frame composition. The layout invariant is the whole point:
// the frame must be exactly as tall as the window and every row exactly as wide,
// or the alternate screen scrolls and the borders come apart.
import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth, stripAnsi } from "./ansi.ts";
import { composeFrame, encodeFrame, toLines, windowInput, type FrameInput } from "./frame.ts";

function base(overrides: Partial<FrameInput> = {}): FrameInput {
  return {
    cols: 80,
    rows: 24,
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    permission: "auto",
    canary: "auto",
    transcript: [],
    streaming: "",
    busy: false,
    status: "",
    spinner: "⠋",
    elapsedMs: 0,
    input: "",
    cursor: 0,
    scroll: 0,
    pending: null,
    ...overrides,
  };
}

const SIZES: Array<[number, number]> = [
  [40, 8],
  [40, 12],
  [60, 14],
  [80, 24],
  [120, 40],
  [200, 60],
];

const HOSTILE_TEXT = [
  "A line that is comfortably short.",
  "",
  "普通の日本語テキストは二セルです",
  "a ".repeat(120).trim(),
  "x".repeat(500),
  JSON.stringify({ deep: { nested: { very: { long: { value: "y".repeat(200) } } } } }),
];

test("encodeFrame clears before drawing, never after", () => {
  // The bug this guards: after a row that fills the window, the cursor sits in
  // the pending-wrap state on the final cell, so a trailing `CSI K` erases that
  // cell — the right border. Every clear must therefore precede its row.
  for (const [cols, rows] of SIZES) {
    const frame = composeFrame(base({ cols, rows, transcript: [{ text: "hello", style: "weaver" }] }));
    const encoded = encodeFrame(frame.lines, false);

    assert.equal(
      encoded,
      `${"\u001b[H"}${frame.lines.map((line) => `\u001b[K${line}`).join("\r\n")}`,
      `encoding at ${cols}x${rows}`,
    );
    assert.match(encoded, /^\u001b\[H(\u001b\[J)?(\u001b\[K[^\r\n]*(\r\n\u001b\[K[^\r\n]*)*)$/);
    assert.ok(!/\u001b\[K\r?\n?$/.test(encoded), "no clear may follow the last row");
  }
});

test("encodeFrame wipes the screen only when asked", () => {
  const frame = composeFrame(base({ cols: 80, rows: 24 }));
  assert.ok(encodeFrame(frame.lines, true).startsWith("\u001b[H\u001b[J"));
  assert.ok(encodeFrame(frame.lines, false).startsWith("\u001b[H\u001b[K"));
});

test("the frame is exactly the window height, at every size", () => {
  for (const [cols, rows] of SIZES) {
    const frame = composeFrame(base({ cols, rows }));
    assert.equal(frame.lines.length, rows, `rows at ${cols}x${rows}`);
  }
});

test("every frame row is exactly the window width", () => {
  for (const [cols, rows] of SIZES) {
    for (const transcript of [[], HOSTILE_TEXT.map((text) => ({ text, style: "weaver" as const }))]) {
      const frame = composeFrame(base({ cols, rows, transcript, input: "日本語の入力 x".repeat(20), cursor: 5 }));
      for (const line of frame.lines) {
        assert.equal(
          displayWidth(line),
          cols,
          `width at ${cols}x${rows}: ${JSON.stringify(stripAnsi(line))}`,
        );
      }
    }
  }
});

test("the frame is exactly the window height while streaming and busy", () => {
  for (const [cols, rows] of SIZES) {
    const frame = composeFrame(
      base({
        cols,
        rows,
        busy: true,
        status: "running read_file",
        streaming: "partial answer that is still arriving and is quite long ".repeat(20),
        transcript: HOSTILE_TEXT.map((text) => ({ text, style: "dim" as const })),
      }),
    );
    assert.equal(frame.lines.length, rows);
    for (const line of frame.lines) assert.equal(displayWidth(line), cols);
  }
});

test("the frame keeps its height with a pending permission prompt", () => {
  const frame = composeFrame(base({ pending: "write_file  src/app.ts (2048 bytes)" }));
  assert.equal(frame.lines.length, 24);
  for (const line of frame.lines) assert.equal(displayWidth(line), 80);
  assert.ok(frame.lines.some((line) => stripAnsi(line).includes("[y] yes")));
});

test("the borders close on the first and last rows", () => {
  const frame = composeFrame(base({ cols: 60, rows: 20 }));
  const first = stripAnsi(frame.lines[0] ?? "");
  const last = stripAnsi(frame.lines[frame.lines.length - 1] ?? "");
  assert.ok(first.startsWith("╭") && first.endsWith("╮"));
  assert.ok(last.startsWith("╰") && last.endsWith("╯"));
  assert.equal(first.length, 60);
});

test("scroll is clamped to what actually exists", () => {
  const short = composeFrame(base({ transcript: [{ text: "one line", style: "dim" }], scroll: 500 }));
  assert.equal(short.maxScroll, 0);
  assert.equal(short.scroll, 0);

  const many = Array.from({ length: 200 }, (_, i) => ({ text: `line ${i}`, style: "dim" as const }));

  const inRange = composeFrame(base({ transcript: many, scroll: 4 }));
  assert.ok(inRange.maxScroll > 4);
  assert.equal(inRange.scroll, 4);

  const over = composeFrame(base({ transcript: many, scroll: 100000 }));
  assert.equal(over.scroll, over.maxScroll);

  // A transcript shorter than the body area cannot scroll at all.
  const tiny = composeFrame(base({ transcript: HOSTILE_TEXT.map((text) => ({ text, style: "dim" as const })), scroll: 5 }));
  assert.equal(tiny.scroll, tiny.maxScroll);
});

test("scrolling up reveals older lines without changing the frame size", () => {
  const transcript = Array.from({ length: 200 }, (_, i) => ({ text: `line ${i}`, style: "dim" as const }));
  const bottom = composeFrame(base({ transcript, rows: 20, scroll: 0 }));
  const up = composeFrame(base({ transcript, rows: 20, scroll: 10 }));

  assert.equal(bottom.lines.length, 20);
  assert.equal(up.lines.length, 20);
  assert.notDeepEqual(bottom.lines, up.lines);
});

test("windowInput keeps the cursor visible and inside the budget", () => {
  const narrow = windowInput("abcdefghijklmnop", 15, 6);
  assert.equal(narrow.shown, "klmnop");
  assert.equal(narrow.at, 5);

  const start = windowInput("abcdefghijklmnop", 0, 6);
  assert.equal(start.shown, "abcdef");
  assert.equal(start.at, 0);

  // Wide characters must be measured in cells, not index units.
  // `shown` already contains the cursor's own character, so it may fill `avail`.
  // Cursor 6 sits on the 7th character; three wide characters fill six cells.
  const wide = windowInput("日本語日本語日本語", 6, 6);
  assert.ok(displayWidth(wide.shown) <= 6, `wide window was ${displayWidth(wide.shown)} cells`);
  assert.equal(wide.shown, "本語日");
  assert.equal(wide.at, 2);
});

test("windowInput never returns a window wider than it was given", () => {
  const samples = ["", "a", "abcdefghij", "日本語のテキスト", "mixed 日本 text 12345", "x".repeat(300)];
  for (const sample of samples) {
    for (const avail of [1, 2, 5, 6, 20, 40]) {
      for (const cursor of [0, Math.floor(sample.length / 2), sample.length]) {
        if (cursor > sample.length) continue;
        const { shown } = windowInput(sample, cursor, avail);
        assert.ok(
          displayWidth(shown) <= avail,
          `avail=${avail} sample=${JSON.stringify(sample)} gave ${displayWidth(shown)}`,
        );
      }
    }
  }
});

// --- The visual layer ---------------------------------------------------------

test("a fenced block becomes a card and is never reflowed", () => {
  const lines = toLines("```ts\nconst answer = 42;\n```", "weaver");
  assert.deepEqual(
    lines.map((line) => line.text),
    ["  ┌─ ts", "  │ const answer = 42;", "  └─"],
  );
  assert.ok(lines.every((line) => line.verbatim === true), "code must be clipped, not wrapped");
});

test("diff markers inside a code block are coloured", () => {
  const lines = toLines("```diff\n-old\n+new\n@@ hunk\n```", "weaver");
  const styleFor = (needle: string): string | undefined =>
    lines.find((line) => line.text.includes(needle))?.segments?.find((segment) => segment.text.includes(needle))?.style;
  assert.equal(styleFor("-old"), "fail");
  assert.equal(styleFor("+new"), "ok");
  assert.equal(styleFor("@@"), "heading");
});

test("a message bullet marks the first line and indents the rest", () => {
  const lines = toLines("first line\nsecond line", "weaver", { bullet: true });
  assert.equal(lines[0]?.text, "● first line");
  assert.equal(lines[1]?.text, "  second line");
});

test("a highlighted code card stays inside the frame", () => {
  const frame = composeFrame(
    base({
      cols: 60,
      rows: 20,
      transcript: toLines("```ts\nconst answer = 42; // the answer\n```", "weaver"),
    }),
  );
  for (const line of frame.lines) assert.equal(displayWidth(line), 60);
});

test("the header carries the brand gradient without changing its width", () => {
  const { lines } = composeFrame(base());
  assert.match(lines[1] ?? "", /\u001b\[38;2;245;183;63m/, "the brand should start at amber");
  for (const line of lines) assert.equal(displayWidth(line), 80);
});
