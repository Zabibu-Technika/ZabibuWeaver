// Offline TUI smoke test.
//
// A raw-mode TUI is awkward to test, but the state machine does not actually need
// a terminal: raw mode is optional, keystrokes are just `data` events, and the
// frame is written to stdout. So this drives the real TUI with synthetic input
// and asserts that frames were painted, the turn ran, and the screen was
// restored. It runs anywhere, including CI with no TTY at all.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTools } from "../src/tools/index.ts";
import { newAgentState } from "../src/core/agent.ts";
import { createMockProvider } from "../src/providers/mock.ts";
import { loadConfig } from "../src/config.ts";
import { runTui } from "../src/tui/app.ts";
import { ALT_OFF, ALT_ON, stripAnsi } from "../src/tui/ansi.ts";

// --- a terminal, or at least the parts of one we use ------------------------
//
// Asserting on the raw byte stream is not enough: the stream can contain a right
// border that the terminal then erases. (It can also erase the border *under* the
// cursor — the exact bug where every row lost its last character, because a
// trailing `CSI K` fired while the cursor sat in the pending-wrap state on the
// final cell.) So we replay the stream through a small emulator that honours the
// clears, and check what is actually left on the screen.
//
// Only the subset Weaver emits is modelled: home, erase-in-line, erase-below,
// CR/LF, and deferred wrap. SGR, cursor visibility and alt-screen are ignored;
// alt-screen *exit* is where we snapshot, before the caller's parting line.

function emulate(stream, cols, rows) {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => " "));
  const snapshots = [];
  let row = 0;
  let col = 0;
  let wrap = false;

  const erase = (r, from) => {
    for (let c = from; c < cols; c += 1) grid[r][c] = " ";
  };

  for (let i = 0; i < stream.length; ) {
    const ch = stream[i];

    if (ch === "\u001b") {
      if (stream[i + 1] !== "[") {
        i += 1;
        continue;
      }
      let j = i + 2;
      while (j < stream.length && !/[A-Za-z]/.test(stream[j])) j += 1;
      const params = stream.slice(i + 2, j);
      const final = stream[j];
      i = j + 1;

      if (final === "H") {
        row = 0;
        col = 0;
        wrap = false;
      } else if (final === "K") {
        // Erases the cell under the cursor — including when wrap is pending.
        erase(row, col);
        wrap = false;
      } else if (final === "J") {
        erase(row, col);
        for (let r = row + 1; r < rows; r += 1) erase(r, 0);
        wrap = false;
      } else if (final === "l" && params === "?1049") {
        snapshots.push(grid.map((line) => line.join("")));
      }
      continue;
    }

    if (ch === "\r") {
      col = 0;
      wrap = false;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row = Math.min(rows - 1, row + 1);
      i += 1;
      continue;
    }

    if (wrap) {
      col = 0;
      row = Math.min(rows - 1, row + 1);
      wrap = false;
    }
    grid[row][col] = ch;
    if (col + 1 >= cols) {
      col = cols - 1;
      wrap = true;
    } else col += 1;
    i += 1;
  }

  return snapshots;
}

// Never touch the user's real ~/.weaver.
const home = mkdtempSync(join(tmpdir(), "weaver-tui-home-"));
process.env.WEAVER_HOME = home;
process.once("exit", () => {
  rmSync(home, { recursive: true, force: true });
});

// --- capture everything the TUI paints -------------------------------------

const painted = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => {
  painted.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return true;
};

// --- run the real TUI ------------------------------------------------------

const config = loadConfig({
  provider: "mock",
  permission: "full",
  workspace: process.cwd(),
  mockScript: undefined,
});

const state = newAgentState();
const meta = {
  id: "smoke-tui",
  createdAt: new Date().toISOString(),
  title: "untitled",
  provider: "mock",
  model: "mock",
  workspace: config.workspace,
};

const press = (text) => process.stdin.emit("data", text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const deadline = setTimeout(() => {
  process.stdout.write = realWrite;
  console.error("SMOKE FAIL (tui): the TUI never exited");
  process.exit(1);
}, 15000);

const session = runTui({
  config,
  provider: createMockProvider(null),
  tools: allTools,
  state,
  meta,
});

await wait(60);
press("hello world");
await wait(60);
press("\r");
await wait(900);
// ctrl+c twice in quick succession exits.
press("\u0003");
await wait(80);
press("\u0003");

await session;
clearTimeout(deadline);

process.stdout.write = realWrite;

// --- assertions ------------------------------------------------------------

const raw = painted.join("");
const screen = stripAnsi(raw);

assert.ok(raw.includes(ALT_ON), "the alternate screen was never entered");
assert.ok(raw.includes(ALT_OFF), "the alternate screen was never left");

assert.ok(screen.includes("╭") && screen.includes("╰"), "no frame borders were painted");
assert.ok(
  screen.includes("weaver · the local-first coding agent"),
  "the header was never painted",
);
assert.ok(screen.includes("hello world"), "the submitted text never reached the transcript");
assert.ok(
  screen.includes("[mock] echo: hello world"),
  "the assistant's reply never reached the transcript",
);
assert.ok(screen.includes("you ▸"), "the input line was never painted");

// --- what actually survived on screen --------------------------------------
//
// The TUI ran without a TTY, so it laid itself out for the 80x24 fallback.
const COLS = 80;
const ROWS = 24;
const screens = emulate(raw, COLS, ROWS);
const final = screens[screens.length - 1];
assert.ok(final !== undefined, "the alternate screen was never left mid-stream");

const wide = final.filter((line) => /^╭─+╮$/.test(line));
const tail = final.filter((line) => /^╰─+╯$/.test(line));
const sides = final.filter((line) => line.startsWith("│") && line.endsWith("│"));

assert.equal(final[0], `╭${"─".repeat(COLS - 2)}╮`, "the top border lost its right corner");
assert.equal(
  final[ROWS - 1],
  `╰${"─".repeat(COLS - 2)}╯`,
  "the bottom border lost its right corner",
);
assert.equal(wide.length, 1);
assert.equal(tail.length, 1);
assert.ok(sides.length >= 3, `only ${sides.length} bordered rows kept their right edge`);

for (const line of final) {
  assert.equal(
    [...line].length,
    COLS,
    `a screen row was not full width: ${JSON.stringify(line)}`,
  );
}

// The turn must have been persisted, and left no empty session behind.
assert.ok(state.messages.length >= 2, `expected a user and assistant message, got ${state.messages.length}`);

console.log(
  `SMOKE PASS (tui): ${painted.length} chunks painted, ${sides.length + 2} bordered rows survived replay, the turn ran, and the screen was restored.`,
);
