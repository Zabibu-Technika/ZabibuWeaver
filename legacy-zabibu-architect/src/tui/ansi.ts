// ANSI helpers: colour, control sequences, and width-aware text.
//
// The width functions are what keep the frame from tearing. A line that contains
// escape sequences has a *visible* width smaller than its length, so padding by
// length would push the right-hand border out of place.

export const ESC = "\u001b";

export const RESET = `${ESC}[0m`;
export const BOLD = `${ESC}[1m`;
export const DIM = `${ESC}[2m`;
export const REVERSE = `${ESC}[7m`;

export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;
export const ALT_ON = `${ESC}[?1049h`;
export const ALT_OFF = `${ESC}[?1049l`;
export const BRACKET_PASTE_ON = `${ESC}[?2004h`;
export const BRACKET_PASTE_OFF = `${ESC}[?2004l`;
export const HOME = `${ESC}[H`;
export const CLEAR_LINE = `${ESC}[K`;
export const CLEAR_BELOW = `${ESC}[J`;

export const AMBER = `${ESC}[38;2;245;183;63m`;
export const GRAY = `${ESC}[90m`;
export const GREEN = `${ESC}[32m`;
export const YELLOW = `${ESC}[33m`;
export const RED = `${ESC}[31m`;
export const CYAN = `${ESC}[36m`;
export const WHITE = `${ESC}[97m`;

const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** East-Asian wide characters occupy two cells. This is a good-enough table. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff)
  );
}

function cellWidth(code: number): number {
  if (code < 32 || code === 0x7f) return 0;
  return isWide(code) ? 2 : 1;
}

/** Visible width of a single character. */
export function charWidth(ch: string): number {
  return cellWidth(ch.codePointAt(0) ?? 0);
}

/** Visible width of a string, ignoring escape sequences. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    width += cellWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

/** Cut plain text to at most `width` visible cells. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = cellWidth(ch.codePointAt(0) ?? 0);
    if (used + w > width) return out;
    out += ch;
    used += w;
  }
  return out;
}

/** Right-pad a string (possibly styled) to a visible width. */
export function padToWidth(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? `${text}${" ".repeat(pad)}` : text;
}

/**
 * Word-wrap plain text to a visible width, honouring explicit newlines and
 * hard-breaking words that are longer than the line.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;

    const flushLong = (): void => {
      while (displayWidth(line) > width) {
        const head = truncate(line, width);
        if (head.length === 0) break;
        out.push(head);
        line = line.slice(head.length);
      }
      lineWidth = displayWidth(line);
    };

    for (const token of rawLine.split(/(\s+)/)) {
      if (token.length === 0) continue;
      const tokenWidth = displayWidth(token);

      if (lineWidth > 0 && lineWidth + tokenWidth > width) {
        out.push(line.trimEnd());
        line = token.trimStart();
        lineWidth = displayWidth(line);
      } else {
        line += token;
        lineWidth += tokenWidth;
      }

      flushLong();
    }

    out.push(line.trimEnd());
  }

  return out;
}

/** Align a styled left and a styled right segment inside `width` cells. */
export function justify(
  left: { plain: string; styled: string },
  right: { plain: string; styled: string },
  width: number,
): string {
  const lw = displayWidth(left.plain);
  const rw = displayWidth(right.plain);
  if (lw + rw + 1 > width) return `${GRAY}${truncate(left.plain, width)}${RESET}`;
  return `${left.styled}${" ".repeat(width - lw - rw)}${right.styled}`;
}
