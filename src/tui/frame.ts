// Pure frame composition for the TUI.
//
// This module knows nothing about terminals, timers, or input — it takes a
// snapshot of the UI state and returns the exact lines to paint. That makes the
// one thing that is painful to test by hand (border alignment, wrapping, and the
// invariant that the frame is exactly as tall as the window) testable.
import * as A from "./ansi.ts";
import { BRAND_FROM, BRAND_TO, gradient } from "../../core/tui/theme.ts";
import type { Style } from "../../core/tui/style.ts";
import { highlight } from "../../core/tui/highlight.ts";
import { segmentsText, truncateSegments, wrapSegments, type Segment } from "../../core/tui/rich.ts";

export type { Style };

export interface FrameLine {
  text: string;
  style: Style;
  /** Styled spans. When present, `text` is their plain concatenation. */
  segments?: Segment[];
  /**
   * Code and card lines must not be word-wrapped: reflowing source changes what it means.
   * They are clipped to the frame instead.
   */
  verbatim?: boolean;
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
    case "keyword":
      return `\u001b[38;2;198;120;221m${text}${A.RESET}`;
    case "string":
      return `\u001b[38;2;152;195;121m${text}${A.RESET}`;
    case "number":
      return `\u001b[38;2;209;154;102m${text}${A.RESET}`;
    case "comment":
      return `${A.DIM}${A.GRAY}${text}${A.RESET}`;
    case "accent":
      return `\u001b[38;2;97;175;239m${text}${A.RESET}`;
    case "bold":
      return `${A.BOLD}${A.WHITE}${text}${A.RESET}`;
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

function lineFrom(segments: Segment[], style: Style, verbatim = false): FrameLine {
  return { text: segmentsText(segments), style, segments, verbatim };
}

/** Inline bold and inline code, the two markers worth honouring without a parser. */
function inlineSegments(text: string, base: Style): Segment[] {
  const out: Segment[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), style: base });
    const token = match[0];
    if (token.startsWith("**")) out.push({ text: token.slice(2, -2), style: "bold" });
    else out.push({ text: token.slice(1, -1), style: "accent" });
    last = match.index + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), style: base });
  return out;
}

/** Markdown-lite: highlighted code cards, inline spans, headings, bullets, quotes. */
export function toLines(
  text: string,
  base: Style,
  options: { closeFence?: boolean; bullet?: boolean } = {},
): FrameLine[] {
  const out: FrameLine[] = [];
  let inCode = false;
  let language = "";

  for (const raw of text.split("\n")) {
    const fence = /^\s*```(\w*)/.exec(raw);
    if (fence !== null) {
      if (!inCode) {
        inCode = true;
        language = (fence[1] ?? "").trim();
        out.push({ text: `  ┌─ ${language.length > 0 ? language : "code"}`, style: "dim", verbatim: true });
      } else {
        inCode = false;
        out.push({ text: "  └─", style: "dim", verbatim: true });
      }
      continue;
    }

    if (inCode) {
      // The prefix is dim; the tokens carry their own colours. A card, not a paragraph.
      const prefix: Segment = { text: "  │ ", style: "dim" };
      out.push(lineFrom([prefix, ...highlight(raw, language)], "code", true));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading !== null) {
      out.push(lineFrom(inlineSegments((heading[2] ?? "").trimEnd(), "heading"), "heading"));
      continue;
    }

    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (bullet !== null) {
      out.push(
        lineFrom(
          [{ text: `${bullet[1] ?? ""}  • `, style: "dim" }, ...inlineSegments(bullet[2] ?? "", base)],
          base,
        ),
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote !== null) {
      out.push(
        lineFrom([{ text: "  │ ", style: "dim" }, ...inlineSegments(quote[1] ?? "", "dim")], "dim", true),
      );
      continue;
    }

    const plain = raw.trimEnd();
    out.push(lineFrom(inlineSegments(plain, base), base));
  }

  // An unclosed fence still gets a closing edge, so the frame never looks broken —
  // unless this is the live stream, where the fence may simply not have arrived yet.
  if (inCode && options.closeFence !== false) {
    out.push({ text: "  └─", style: "dim", verbatim: true });
  }

  // A message marker, the way a chat client shows who is speaking. Continuation lines
  // are indented to the same column, so the text reads as one block.
  if (options.bullet === true && out.length > 0) {
    for (let index = 0; index < out.length; index += 1) {
      const line = out[index];
      if (line === undefined) continue;
      const prefix: Segment = { text: index === 0 ? "● " : "  ", style: line.style };
      const segments = [prefix, ...(line.segments ?? [{ text: line.text, style: line.style }])];
      out[index] = { ...line, text: segmentsText(segments), segments };
    }
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
    styled: `${A.BOLD}${gradient("weaver", BRAND_FROM, BRAND_TO)}${A.GRAY} · the local-first coding agent${A.RESET}`,
  };
  const shortLeft = {
    plain: "weaver",
    styled: `${A.BOLD}${gradient("weaver", BRAND_FROM, BRAND_TO)}`,
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

function append(out: FrameLine[], line: FrameLine, inner: number): void {
  if (line.text.length === 0) {
    out.push({ text: "", style: line.style });
    return;
  }

  if (line.verbatim === true) {
    const segments =
      line.segments !== undefined
        ? truncateSegments(line.segments, inner)
        : [{ text: A.truncate(line.text, inner), style: line.style }];
    out.push({ text: segmentsText(segments), style: line.style, segments, verbatim: true });
    return;
  }

  if (line.segments !== undefined && line.segments.length > 0) {
    for (const chunk of wrapSegments(line.segments, inner)) {
      out.push({ text: segmentsText(chunk), style: line.style, segments: chunk });
    }
    return;
  }

  for (const chunk of A.wrapText(line.text, inner)) out.push({ text: chunk, style: line.style });
}

function bodyLines(input: FrameInput, inner: number): FrameLine[] {
  const out: FrameLine[] = [];

  for (const line of input.transcript) append(out, line, inner);

  if (input.streaming.length > 0) {
    // Render the live text with the same markdown rules as the committed text, so a code
    // block does not visibly reflow when the turn ends. An unclosed fence gets no bottom
    // edge until it actually closes.
    for (const line of toLines(input.streaming, "weaver", { closeFence: false, bullet: true })) append(out, line, inner);
  }

  if (input.busy) {
    out.push({ text: "", style: "dim" });
    out.push({ text: statusLine(input), style: "canary" });
  }

  return out;
}

/**
 * Turn frame lines into the exact byte sequence to paint.
 * The implementation lives in `core/tui/canvas.ts` so Arif Agent's dashboard inherits the same
 * pending-wrap fix rather than rediscovering it.
 */
export { encodeFrame } from "../../core/tui/canvas.ts";

/** Render one line, honouring styled spans when present. */
function renderLine(line: FrameLine): string {
  if (line.segments !== undefined && line.segments.length > 0) {
    let out = "";
    for (const segment of line.segments) out += styleOf(segment.style ?? line.style, segment.text);
    return out;
  }
  return styleOf(line.style, line.text);
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
    lines.push(frameRow(line === undefined ? "" : renderLine(line), inner));
  }

  lines.push(border("├", "┤", cols));
  lines.push(frameRow(inputLine(input, inner), inner));
  if (!compact) lines.push(frameRow(hintLine(input, inner), inner));
  lines.push(border("╰", "╯", cols));

  return { lines, scroll, maxScroll };
}
