// Overlays: a panel on top of a dimmed frame.
//
// A terminal has no z-index, so an overlay is a composition: dim every base line, then
// overwrite the rows the panel occupies. That is enough for a command palette, a session
// picker, or a confirmation without a component tree — and it keeps the exact-width
// contract the rest of the frame depends on.
import { DIM, RESET, displayWidth } from "./ansi.ts";
import { panel, type Row } from "./box.ts";

export interface OverlayOptions {
  title: string;
  rows: Row[];
  /** Terminal columns. */
  width: number;
  /** Terminal rows. */
  height: number;
  /** Panel width. Defaults to min(64, width - 4). */
  panelWidth?: number;
  /** Dim the background. Default true. */
  dim?: boolean;
}

/**
 * Compose an overlay over `base`.
 *
 * `base` must already be exact-width. The result is exact-width too, and the same height,
 * because an overlay that changes the frame size scrolls the alternate screen.
 */
export function overlay(base: string[], options: OverlayOptions): string[] {
  const cols = Math.max(1, Math.floor(options.width));
  const rows = Math.max(1, Math.floor(options.height));
  const width = Math.max(12, Math.min(options.panelWidth ?? 64, cols - 2));
  const contentHeight = Math.max(1, Math.min(options.rows.length, rows - 4));
  const panelHeight = contentHeight + 2;

  const lines = base.map((line) => (options.dim === false ? line : `${DIM}${line}${RESET}`));
  const panelLines = panel({
    title: options.title,
    rows: options.rows.slice(0, contentHeight),
    width,
    height: panelHeight,
    style: { border: "\u001b[90m", title: "\u001b[1m\u001b[38;2;245;183;63m", right: "\u001b[90m" },
  });

  const left = Math.max(0, Math.floor((cols - width) / 2));
  const top = Math.max(0, Math.floor((rows - panelHeight) / 2));

  for (let index = 0; index < panelLines.length; index += 1) {
    const row = top + index;
    if (row < 0 || row >= lines.length) continue;
    const line = panelLines[index] ?? "";
    lines[row] = `${" ".repeat(left)}${line}${" ".repeat(Math.max(0, cols - left - displayWidth(line)))}`;
  }

  return lines;
}
