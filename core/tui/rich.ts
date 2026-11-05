// Styled spans: the missing half of the line model.
//
// A `FrameLine` with a single style can say "this row is amber". It cannot say "`const` is
// purple, `42` is yellow, and the comment is grey" — which is exactly what makes a code
// block look finished. A line is now a sequence of segments, each with its own style, and
// wrapping carries the styles across line breaks.
//
// The plain text is kept alongside the segments so width maths, truncation, and tests can
// stay honest: a styled line is still exactly as wide as its characters.
import { displayWidth, truncate } from "./ansi.ts";
import type { Style } from "./style.ts";

export interface Segment {
  text: string;
  style?: Style;
}

export function segmentsText(segments: Segment[]): string {
  let out = "";
  for (const segment of segments) out += segment.text;
  return out;
}

export function segmentsWidth(segments: Segment[]): number {
  let width = 0;
  for (const segment of segments) width += displayWidth(segment.text);
  return width;
}

/** Cut a styled line to `width` cells, keeping the style of what remains. */
export function truncateSegments(segments: Segment[], width: number): Segment[] {
  if (width <= 0) return [];
  const out: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    const room = width - used;
    if (room <= 0) break;
    const text = truncate(segment.text, room);
    if (text.length > 0) out.push({ text, style: segment.style });
    used += displayWidth(text);
  }
  return out;
}

/**
 * Word-wrap styled segments to `width`.
 *
 * Whitespace is collapsed to one cell, which is the right trade for prose and irrelevant
 * for code (code is truncated, never wrapped). A word longer than the line is hard-broken
 * rather than allowed to overflow the frame.
 */
export function wrapSegments(segments: Segment[], width: number): Segment[][] {
  if (width <= 0) return [segments];

  const lines: Segment[][] = [];
  let line: Segment[] = [];
  let used = 0;

  const flush = (): void => {
    if (line.length > 0) {
      lines.push(line);
      line = [];
      used = 0;
    }
  };

  for (const segment of segments) {
    for (const token of segment.text.split(/(\s+)/)) {
      if (token.length === 0) continue;

      if (/^\s+$/.test(token)) {
        if (used > 0 && used + 1 <= width) {
          line.push({ text: " ", style: segment.style });
          used += 1;
        }
        continue;
      }

      const tokenWidth = displayWidth(token);
      if (used > 0 && used + tokenWidth > width) flush();

      if (tokenWidth > width) {
        let rest = token;
        while (displayWidth(rest) > width) {
          const head = truncate(rest, width);
          if (head.length === 0) break;
          line.push({ text: head, style: segment.style });
          lines.push(line);
          line = [];
          used = 0;
          rest = rest.slice(head.length);
        }
        if (rest.length > 0) {
          line.push({ text: rest, style: segment.style });
          used = displayWidth(rest);
        }
        continue;
      }

      line.push({ text: token, style: segment.style });
      used += tokenWidth;
    }
  }

  flush();
  return lines.length > 0 ? lines : [[]];
}
