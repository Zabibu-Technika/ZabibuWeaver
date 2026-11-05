// Layout primitives for a terminal dashboard.
//
// Every function here returns strings whose **visible width is exact**. That is the whole
// contract, and it is why the borders do not tear: padding by `string.length` is wrong the
// moment a line contains a wide character or an escape sequence, and a dashboard that
// tears on a Ge'ez name is a dashboard that is not finished.
//
// Kept in `core/` rather than in either app because both products draw boxes, and a second
// implementation would drift on the first wide-character bug.
import { displayWidth, padToWidth, RESET, truncate } from "./ansi.ts";

export interface Row {
  /** Plain text. Styles belong in `style`, so width maths stays honest. */
  text: string;
  /** An ANSI style prefix, applied to the whole row. */
  style?: string;
}

/** Fit plain text into exactly `width` visible cells. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return padToWidth(truncate(text, width), width);
}

export function renderRow(row: Row, width: number): string {
  const body = fit(row.text, width);
  return row.style === undefined ? body : `${row.style}${body}${RESET}`;
}

/** Split a total width into a left column and the remaining right column. */
export function splitWidth(width: number, left: number, gap = 1): { left: number; right: number } {
  const leftWidth = Math.max(0, Math.min(left, Math.max(0, width - gap)));
  return { left: leftWidth, right: Math.max(0, width - leftWidth - gap) };
}

export interface PanelStyle {
  border?: string;
  title?: string;
  right?: string;
}

function wrap(style: string | undefined, text: string): string {
  return style === undefined || style.length === 0 ? text : `${style}${text}${RESET}`;
}

export interface PanelOptions {
  title?: string;
  /** Right-aligned label in the top border, e.g. a count. */
  right?: string;
  rows: Row[];
  width: number;
  /** Includes the top and bottom border rows. */
  height: number;
  /** Horizontal inset inside the border. Default 1. */
  padding?: number;
  style?: PanelStyle;
}

/**
 * A bordered panel of exactly `width` × `height` cells.
 *
 * Content is clipped and padded, never wrapped: a dashboard row that grows by one line
 * pushes every border below it out of place. Callers that want wrapping should wrap before
 * passing rows in.
 */
export function panel(options: PanelOptions): string[] {
  const width = Math.max(4, Math.floor(options.width));
  const height = Math.max(2, Math.floor(options.height));
  const inner = width - 2;
  const padding = Math.max(0, Math.min(options.padding ?? 1, Math.floor(inner / 2)));
  const contentWidth = Math.max(0, inner - padding * 2);
  const style = options.style ?? {};

  const leftLabel = options.title === undefined || options.title.length === 0 ? "" : ` ${options.title} `;
  const rightLabel = options.right === undefined || options.right.length === 0 ? "" : ` ${options.right} `;

  let left = truncate(leftLabel, inner);
  let right = truncate(rightLabel, Math.max(0, inner - displayWidth(left)));
  if (displayWidth(left) + displayWidth(right) > inner) {
    right = truncate(right, Math.max(0, inner - displayWidth(left)));
  }
  const fill = Math.max(0, inner - displayWidth(left) - displayWidth(right));

  const top = `${wrap(style.border, "╭")}${wrap(style.title, left)}${wrap(
    style.border,
    "─".repeat(fill),
  )}${wrap(style.right, right)}${wrap(style.border, "╮")}`;

  const lines: string[] = [top];
  const contentHeight = height - 2;
  for (let index = 0; index < contentHeight; index += 1) {
    const row = options.rows[index];
    const body = renderRow(row ?? { text: "" }, contentWidth);
    const inset = row === undefined ? " ".repeat(contentWidth) : body;
    lines.push(
      `${wrap(style.border, "│")}${" ".repeat(padding)}${inset}${" ".repeat(
        padding,
      )}${wrap(style.border, "│")}`,
    );
  }
  lines.push(`${wrap(style.border, "╰")}${wrap(style.border, "─".repeat(inner))}${wrap(style.border, "╯")}`);
  return lines;
}

/** Put two equally tall blocks side by side. Each block must already be exact width. */
export function joinColumns(left: string[], right: string[], leftWidth: number, gap = 1): string[] {
  const height = Math.max(left.length, right.length);
  const pad = " ".repeat(leftWidth);
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    const l = left[index] ?? pad;
    const r = right[index] ?? "";
    lines.push(`${l}${" ".repeat(gap)}${r}`);
  }
  return lines;
}

/** A horizontal rule of exactly `width` cells. */
export function rule(width: number, character = "─"): string {
  if (width <= 0) return "";
  return character.repeat(width);
}
