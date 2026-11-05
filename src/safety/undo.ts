// The undo surface: what a checkpoint means to a person.
//
// `checkpoints.ts` knows how to put bytes back. This module answers the two questions a
// user actually asks — *what* will change, and *is this the one I meant* — because a
// restore prompt that says "restore checkpoint 7" is not something a non-developer can
// consent to, and consent that cannot be informed is a ritual rather than a control.
//
// The asymmetry worth remembering: capture is automatic and silent, restore is deliberate
// and loud. That is the correct shape. Nothing here runs on its own.
import {
  diff,
  list,
  restore,
  type Change,
  type Checkpoint,
  type RestoreResult,
  type Store,
} from "./checkpoints.ts";

export interface UndoPreview {
  id: string;
  tool: string;
  label: string;
  turn: number;
  createdAt: number;
  changes: Change[];
  /** Files undo puts back, because they were edited or deleted after capture. */
  restore: string[];
  /** Files undo deletes, because the call created them. */
  remove: string[];
  /** Files already in their captured state — undo leaves them alone. */
  untouched: number;
  /** Files the sweep declined to cover. Undo cannot reach them, and says so. */
  skipped: number;
  /**
   * How many newer checkpoints exist.
   *
   * Non-zero means restoring this one is a time machine: it also reverts later work to
   * the same files. Worth saying out loud before someone presses yes.
   */
  newer: number;
}

function classify(changes: Change[]): Pick<UndoPreview, "restore" | "remove" | "untouched"> {
  const restorePaths: string[] = [];
  const removePaths: string[] = [];
  let untouched = 0;
  for (const change of changes) {
    if (change.status === "added") removePaths.push(change.path);
    else if (change.status === "modified" || change.status === "removed") restorePaths.push(change.path);
    else untouched += 1;
  }
  return { restore: restorePaths, remove: removePaths, untouched };
}

/**
 * Build the preview for one checkpoint.
 *
 * Returns null when the id is unknown *or* has already been applied — a consumed
 * checkpoint is genuinely gone, and pretending otherwise would let a double-tap undo
 * twice.
 */
export async function preview(store: Store, workspace: string, id: string): Promise<UndoPreview | null> {
  const entries = await list(store);
  const entry: Checkpoint | undefined = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) return null;

  const changes = await diff(store, workspace, id);
  if (changes === null) return null;

  return {
    id: entry.id,
    tool: entry.tool,
    label: entry.label,
    turn: entry.turn,
    createdAt: entry.createdAt,
    changes,
    ...classify(changes),
    skipped: entry.skipped.length,
    newer: entries.filter((candidate) => candidate.createdAt > entry.createdAt).length,
  };
}

/** The checkpoint `/undo` would take: the newest one still in the index. */
export async function previewLatest(store: Store, workspace: string): Promise<UndoPreview | null> {
  const entries = await list(store);
  const newest = entries[0];
  if (newest === undefined) return null;
  return preview(store, workspace, newest.id);
}

/** Apply a preview. The checkpoint is consumed on success, exactly once. */
export async function apply(store: Store, workspace: string, id: string): Promise<RestoreResult | null> {
  return restore(store, workspace, id);
}

/** Plain-text description, for both the CLI and the TUI to colour however they like. */
export function describe(undo: UndoPreview): { headline: string; lines: string[] } {
  const headline = `undo ${undo.id} · ${undo.tool}: ${undo.label || "(no label)"}`;
  const lines: string[] = [];

  for (const path of undo.restore) lines.push(`restore  ${path}`);
  for (const path of undo.remove) lines.push(`delete   ${path}`);

  if (undo.restore.length === 0 && undo.remove.length === 0) {
    lines.push("nothing to change — the workspace already matches this checkpoint.");
  }
  if (undo.untouched > 0) {
    lines.push(`leave    ${undo.untouched} file(s) already as they were`);
  }
  if (undo.skipped > 0) {
    lines.push(`cannot   ${undo.skipped} file(s) the checkpoint declined to cover`);
  }
  if (undo.newer > 0) {
    lines.push(
      `warning  ${undo.newer} newer checkpoint(s) exist — this also reverts later edits to the same files`,
    );
  }
  return { headline, lines };
}

/** Plain-text result, so a partial undo is never reported as a clean one. */
export function describeResult(result: RestoreResult): string[] {
  const lines: string[] = [];
  if (result.restored.length > 0) lines.push(`restored ${result.restored.length} file(s)`);
  if (result.deleted.length > 0) lines.push(`deleted ${result.deleted.length} file(s)`);
  if (result.missing.length > 0) {
    lines.push(
      `could not restore ${result.missing.length} file(s) — their saved copies are gone: ${result.missing
        .slice(0, 5)
        .join(", ")}${result.missing.length > 5 ? ", …" : ""}`,
    );
    lines.push("the checkpoint was kept out of the undo chain so this failure is not forgotten.");
  }
  if (lines.length === 0) lines.push("nothing needed changing.");
  return lines;
}
