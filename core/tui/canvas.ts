// Encoding a frame to the terminal.
//
// This is subtle enough to live in one place. Clearing is emitted *before* each row
// rather than after it: after a row that fills the window the cursor sits on the final
// cell in the terminal's pending-wrap state, and a `CSI K` written there erases the cell
// *under* the cursor — the row's last character. Clearing first, from column zero,
// sidesteps that entirely.
//
// `wipe` adds one erase-below for the first paint and for resizes, where the previous
// frame may have been taller than this one. It is never needed afterwards, because a
// frame is exactly as tall as the window.
//
// No newline follows the last row: that would scroll the alternate screen.
import { CLEAR_BELOW, CLEAR_LINE, HOME } from "./ansi.ts";

export function encodeFrame(lines: string[], wipe: boolean): string {
  let out = HOME;
  if (wipe) out += CLEAR_BELOW;

  for (let index = 0; index < lines.length; index += 1) {
    out += `${CLEAR_LINE}${lines[index] ?? ""}`;
    if (index < lines.length - 1) out += "\r\n";
  }

  return out;
}
