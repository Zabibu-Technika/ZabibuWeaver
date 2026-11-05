// Pure frame composition for the TUI.
//
// This module knows nothing about terminals, timers, or input — it takes a
// snapshot of the UI state and returns the exact lines to paint. That makes the
// one thing that is painful to test by hand (border alignment, wrapping, and the
// invariant that the frame is exactly as tall as the window) testable.
import * as A from "./ansi.ts";

export type Style =
  | "user"
  | "weaver"
  | "heading"
  | "code"
  | "tool"
  | "ok"
  | "fail"
  | "warn"
  | "error"
  | "notice"
  | "canary"
  | "dim";

export interface FrameLine {
  text: string;
  style: Style;
}

export interface FrameInput {
  cols: number;
  rows: number;
  provider: string;
  model: string;
  permission: string;
  canary: string;
  transcript: FrameLine[];
  streaming: string;
  busy: boolean;
  /** e.g. "thinking", "running read_file". */
  status: string;
  /** Which spinner glyph to show. */
  spinner: string;
  /** Milliseconds since the turn started, for the status timer. */
  elapsedMs: number;
  input: string;
  cursor: number;
  scroll: number;
  /** The question awaiting a y/n/a answer, or null. */
  pending: string | null;
}

export interface FrameResult {
  lines: string[];
  /** The scroll offset actually used, after clamping to what exists. */
  scroll: number;
  maxScroll: number;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const MIN_COLS = 40;
export const MIN_ROWS = 8;

/** Below this height the hint row is dropped to keep room for the transcript. */
const COMPACT_ROWS = 14;

export function styleOf(style: Style, text: string): string {
  switch (style) {
    case "user":
      return `${A.CYAN}${text}${A.RESET}`;
    case "weaver":
      return `${A.WHITE}${text}${A.RESET}`;
    case "heading":
      return `${A.AMBER}${A.BOLD}${text}${A.RESET}`;
    case "code":
      return `${A.GRAY}${text}${A.RESET}`;
    case "tool":
      return `${A.DIM}${text}${A.RESET}`;
    case "ok":
      return `${A.GREEN}${text}${A.RESET}`;
    case "fail":
      return `${A.RED}${text}${A.RESET}`;
    case "warn":
      return `${A.YELLOW}${text}${A.RESET}`;
    case "error":
      return `${A.RED}${text}${A.RESET}`;
    case "canary":
      return `${A.AMBER}${text}${A.RESET}`;
    case "notice":
    case "dim":
    default:
      return `${A.GRAY}${text}${A.RESET}`;
  }
}

export function severityStyle(severity: string): Style {
  if (severity === "critical") return "fail";
  if (severity === "high") return "warn";
  return "dim";
}

/** Markdown-lite: fences, headings, and stripping inline emphasis. */
export function toLines(text: string, base: Style): FrameLine[] {
  const out: FrameLine[] = [];
  let inCode = false;

  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push({ text: `  ${raw}`, style: "code" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    const plain = (heading !== null ? (heading[2] ?? "") : raw).replace(/\*\*/g, "").replace(/`/g, "");
    out.push({ text: plain.trimEnd(), style: heading !== null ? "heading" : base });
  }

  return out;
}

/** A one-line summary of a tool call's arguments, favouring the telling ones. */
export function summarizeArgs(args: Record<string, unknown>): string {
  for (const key of ["path", "command", "pattern", "folder_name", "name", "query"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return A.truncate(value, 72);
  }
  return A.truncate(JSON.stringify(args), 72);
}

export function firstLines(output: string, count: number): string[] {
  return output
    .split("\n")
    .slice(0, count)
    .map((line) => A.truncate(line, 110));
}

function border(left: string, right: string, cols: number): string {
  return `${A.GRAY}${left}${"─".repeat(Math.max(0, cols - 2))}${right}${A.RESET}`;
}

function frameRow(content: string, inner: number): string {
  return `${A.GRAY}│${A.RESET} ${A.padToWidth(content, inner)} ${A.GRAY}│${A.RESET}`;
}

function headerLine(input: FrameInput, inner: number): string {
  const right = {
    plain: `${input.provider}/${input.model} · ${input.permission}`,
    styled: `${A.GRAY}${input.provider}/${input.model} · ${input.permission}${A.RESET}`,
  };
  const longLeft = {
    plain: "weaver · the local-first coding agent",
    styled: `${A.AMBER}${A.BOLD}weaver${A.RESET}${A.GRAY} · the local-first coding agent${A.RESET}`,
  };
  const shortLeft = {
    plain: "weaver",
    styled: `${A.AMBER}${A.BOLD}weaver${A.RESET}`,
  };

  // Shed the tagline before shedding the provider — that is the part a user
  // actually squints at when something is misbehaving.
  const fits = (
    left: { plain: string },
    side: { plain: string },
  ): boolean => A.displayWidth(left.plain) + A.displayWidth(side.plain) + 1 <= inner;

  if (fits(longLeft, right)) return A.justify(longLeft, right, inner);
  if (fits(shortLeft, right)) return A.justify(shortLeft, right, inner);
  return A.justify(longLeft, right, inner);
}

/**
 * Choose the slice of the input to show so the cursor stays visible.
 *
 * This works in display cells, not string indices: a window measured in code
 * units would overflow the row as soon as someone types a wide character.
 * The result is guaranteed to fit in `avail` cells including the cursor cell.
 */
export function windowInput(
  text: string,
  cursor: number,
  avail: number,
): { shown: string; at: number } {
  const chars = [...text];

  // The character index the cursor sits on.
  let index = 0;
  let seen = 0;
  while (index < chars.length && seen < cursor) {
    seen += (chars[index] ?? "").length;
    index += 1;
  }

  // Reserve one cell for the cursor itself before filling behind it.
  const budget = Math.max(1, avail - 1);
  const before: string[] = [];
  let used = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = chars[i] ?? "";
    const width = A.charWidth(ch);
    if (used + width > budget) break;
    before.unshift(ch);
    used += width;
  }

  const after: string[] = [];
  for (let i = index; i < chars.length; i += 1) {
    const ch = chars[i] ?? "";
    const width = A.charWidth(ch);
    if (used + width > avail) break;
    after.push(ch);
    used += width;
  }

  const head = before.join("");
  return { shown: `${head}${after.join("")}`, at: head.length };
}

function inputLine(input: FrameInput, inner: number): string {
  if (input.pending !== null) {
    const options = "   [y] yes   [n] no   [a] always";
    const ask = `allow ${input.pending}?`;
    const optionsWidth = A.displayWidth(options);

    // Keep the answer keys on screen: shrink the question, never the options.
    if (inner > optionsWidth + 12) {
      const room = inner - optionsWidth;
      return `${A.YELLOW}${A.BOLD}${A.truncate(ask, room)}${A.RESET}${A.GRAY}${options}${A.RESET}`;
    }
    return `${A.YELLOW}${A.BOLD}${A.truncate(ask, inner)}${A.RESET}`;
  }

  // "you ▸ " is six cells, and the cursor cell is one more.
  const avail = Math.max(1, inner - 7);
  const { shown, at } = windowInput(input.input, input.cursor, avail);

  const before = shown.slice(0, at);
  const under = shown.slice(at, at + 1);
  const after = shown.slice(at + 1);

  return (
    `${A.CYAN}${A.BOLD}you${A.RESET}${A.GRAY} ▸ ${A.RESET}` +
    `${before}${A.REVERSE}${under.length > 0 ? under : " "}${A.RESET}${after}`
  );
}

function hintLine(input: FrameInput, inner: number): string {
  if (input.busy) {
    const left = "esc or ctrl+c cancels · enter queues a follow-up";
    const right = input.status.length > 0 ? input.status : "working";
    return A.justify(
      { plain: left, styled: `${A.GRAY}${left}${A.RESET}` },
      { plain: right, styled: `${A.AMBER}${right}${A.RESET}` },
      inner,
    );
  }

  const left = "enter send · /help · ↑↓ history · ctrl+c twice exits";
  const right = `${input.permission} · canary ${input.canary}`;
  return A.justify(
    { plain: left, styled: `${A.GRAY}${left}${A.RESET}` },
    { plain: right, styled: `${A.GRAY}${right}${A.RESET}` },
    inner,
  );
}

function statusLine(input: FrameInput): string {
  const seconds = (input.elapsedMs / 1000).toFixed(1);
  return `${input.spinner} ${input.status.length > 0 ? input.status : "working"}  ${seconds}s`;
}

function bodyLines(input: FrameInput, inner: number): FrameLine[] {
  const out: FrameLine[] = [];

  for (const line of input.transcript) {
    if (line.text.length === 0) {
      out.push({ text: "", style: line.style });
      continue;
    }
    for (const chunk of A.wrapText(line.text, inner)) out.push({ text: chunk, style: line.style });
  }

  if (input.streaming.length > 0) {
    for (const chunk of A.wrapText(input.streaming, inner)) out.push({ text: chunk, style: "weaver" });
  }

  if (input.busy) {
    out.push({ text: "", style: "dim" });
    out.push({ text: statusLine(input), style: "canary" });
  }

  return out;
}

/**
 * Turn frame lines into the exact byte sequence to paint.
 *
 * Clearing is emitted *before* each row rather than after it. That ordering
 * matters: after a row that fills the window the cursor sits on the final cell
 * in the terminal's pending-wrap state, and a `CSI K` written there erases the
 * cell *under* the cursor — the row's last character. Clearing first, from
 * column zero, sidesteps that entirely.
 *
 * `wipe` adds one `CSI J` (erase below) for the first paint and for resizes,
 * where the previous frame may have been taller than this one. It is never
 * needed afterwards, because a frame is exactly as tall as the window.
 *
 * No newline follows the last row: that would scroll the alternate screen.
 */
export function encodeFrame(lines: string[], wipe: boolean): string {
  let out = A.HOME;
  if (wipe) out += A.CLEAR_BELOW;

  for (let i = 0; i < lines.length; i += 1) {
    out += `${A.CLEAR_LINE}${lines[i] ?? ""}`;
    if (i < lines.length - 1) out += "\r\n";
  }

  return out;
}

/**
 * Build the full frame. The returned array is always exactly `rows` lines, each
 * exactly `cols` cells wide, so the caller can write it without scrolling the
 * alternate screen.
 */
export function composeFrame(input: FrameInput): FrameResult {
  const cols = Math.max(MIN_COLS, Math.floor(input.cols));
  const rows = Math.max(MIN_ROWS, Math.floor(input.rows));
  const inner = Math.max(1, cols - 4);

  const compact = rows < COMPACT_ROWS;
  const footerCount = compact ? 3 : 4;
  const bodyHeight = Math.max(1, rows - 3 - footerCount);

  const all = bodyLines(input, inner);
  const maxScroll = Math.max(0, all.length - bodyHeight);
  const scroll = Math.min(Math.max(0, input.scroll), maxScroll);
  const end = Math.max(0, all.length - scroll);
  const start = Math.max(0, end - bodyHeight);
  const windowed = all.slice(start, end);

  const lines: string[] = [];
  lines.push(border("╭", "╮", cols));
  lines.push(frameRow(headerLine(input, inner), inner));
  lines.push(border("├", "┤", cols));

  for (let i = 0; i < bodyHeight; i += 1) {
    const line = windowed[i];
    lines.push(frameRow(line === undefined ? "" : styleOf(line.style, line.text), inner));
  }

  lines.push(border("├", "┤", cols));
  lines.push(frameRow(inputLine(input, inner), inner));
  if (!compact) lines.push(frameRow(hintLine(input, inner), inner));
  lines.push(border("╰", "╯", cols));

  return { lines, scroll, maxScroll };
}
