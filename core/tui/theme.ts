// Shared visual language: gradients, badges, and bars.
//
// "Fancy" in a terminal is not magic. Claude Code and OpenCode feel richer because they
// use component frameworks with a retained tree: inline spans, overlays, dialogs, themes.
// Weaver and Arif Agent use a hand-rolled frame with one style per line, which is why they
// have no dependencies, run on a 4 GB machine, and never tear on a wide script.
//
// This module adds the highest-value pieces of the visual layer without changing that
// model: a gradient brand, small status badges, and a meter. All of it is visible-width
// aware, because a pretty bar that breaks the border is worse than no bar.
import { DIM, RESET } from "./ansi.ts";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Weaver's amber, and the warmer end we blend toward. */
export const BRAND_FROM: Rgb = { r: 245, g: 183, b: 63 };
export const BRAND_TO: Rgb = { r: 255, g: 112, b: 48 };

function fg(colour: Rgb): string {
  return `\u001b[38;2;${colour.r};${colour.g};${colour.b}m`;
}

function bg(colour: Rgb): string {
  return `\u001b[48;2;${colour.r};${colour.g};${colour.b}m`;
}

/**
 * Blend a short string from one colour to another, one code point at a time.
 *
 * Short labels only: a gradient across a paragraph is a novelty, not a design.
 */
export function gradient(text: string, from: Rgb = BRAND_FROM, to: Rgb = BRAND_TO): string {
  const characters = [...text];
  if (characters.length === 0) return "";
  const span = Math.max(1, characters.length - 1);

  let out = "";
  for (const [index, character] of characters.entries()) {
    const t = index / span;
    out += `${fg({
      r: Math.round(from.r + (to.r - from.r) * t),
      g: Math.round(from.g + (to.g - from.g) * t),
      b: Math.round(from.b + (to.b - from.b) * t),
    })}${character}`;
  }
  return `${out}${RESET}`;
}

export type Tone = "ok" | "warn" | "fail" | "info" | "muted";

const TONES: Record<Tone, { background: Rgb; foreground: Rgb }> = {
  ok: { background: { r: 34, g: 150, b: 84 }, foreground: { r: 8, g: 18, b: 12 } },
  warn: { background: { r: 214, g: 158, b: 46 }, foreground: { r: 24, g: 16, b: 6 } },
  fail: { background: { r: 190, g: 62, b: 62 }, foreground: { r: 20, g: 8, b: 8 } },
  info: { background: { r: 62, g: 140, b: 170 }, foreground: { r: 8, g: 16, b: 20 } },
  muted: { background: { r: 70, g: 70, b: 74 }, foreground: { r: 225, g: 225, b: 225 } },
};

/** A small filled label. `proved`, `partial`, `failed` read at a glance. */
export function badge(text: string, tone: Tone = "muted"): string {
  const colours = TONES[tone];
  return `${bg(colours.background)}${fg(colours.foreground)} ${text} ${RESET}`;
}

/**
 * A meter of exactly `width` cells. Values outside [0, 1] are clamped, because a bar
 * that grows past its box is the same bug as a row that wraps.
 */
export function bar(fraction: number, width: number, tone: Tone = "ok"): string {
  const cells = Math.max(0, Math.floor(width));
  if (cells === 0) return "";
  const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  const filled = Math.round(safe * cells);
  return `${fg(TONES[tone].background)}${"█".repeat(filled)}${RESET}${DIM}${"░".repeat(cells - filled)}${RESET}`;
}
