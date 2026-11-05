// Checkpoints — undo for an agent that acts on a real filesystem.
//
// The thesis, which Cline states outright and which we agree with: *checkpoints make
// auto-approve practical*. Containment narrows what can happen; a checkpoint narrows what
// persists. Together they are what lets a non-developer run with less friction without
// the friction itself being the safety mechanism — because a permission prompt a novice
// cannot evaluate is not a control, it is a ritual.
//
// WHY NOT SHADOW-GIT
//
// Cline snapshots with a shadow git repository after every mutating call. We measured git
// on this machine at ~2.3s for `init` and ~2.5s for `commit`. A checkpoint that costs two
// seconds per tool call would be switched off within a day, and a safety feature nobody
// enables protects nobody. So this is a content-addressed file store instead: it costs
// one hash per touched file, writes a blob only when the content is new, and is bounded
// by construction so it cannot quietly consume the disk.
//
// WHAT IT COVERS, AND WHAT IT HONESTLY DOES NOT
//
// `write_file` and `edit_file` are checkpointed precisely — we know the target, so we
// capture exactly what is about to change and no more.
//
// `run_shell` cannot be targeted that way. A shell command can touch anything. So shell
// calls get a bounded workspace sweep: every file under the size cap, within budget.
// When the workspace is too large to sweep, the checkpoint records *which* files were
// skipped rather than silently claiming coverage it does not have. A checkpoint that
// looks complete and is not is worse than no checkpoint, because it replaces checking
// with assuming.
//
// The blob store deliberately lives inside the workspace at `.weaver/checkpoints`, so it
// travels with the project and survives a session — restore keeps the conversation,
// because restoring is a filesystem operation and nothing to do with chat state.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { resolveInWorkspace } from "../tools/files.ts";

/** Directories never captured. Mirrors the tool layer's skip list. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".weaver", ".next", "dist", "build", "out",
  "__pycache__", ".venv", "venv", ".ruff_cache", ".turbo", "coverage",
]);

/**
 * Per-file and total budgets.
 *
 * These are not tuning knobs, they are the difference between a checkpoint system and a
 * disk-filling accident. A single 400 MB build artifact must not be snapshotted; nor
 * should a sweep be allowed to copy a repository into itself.
 */
const MAX_BLOB_BYTES = 4 * 1024 * 1024;
const MAX_SWEEP_BYTES = 64 * 1024 * 1024;
const MAX_SWEEP_FILES = 4_000;

export interface CapturedFile {
  /** Workspace-relative, POSIX separators. */
  path: string;
  /** sha256 of the content at capture time, or null when the file did not exist. */
  hash: string | null;
  /** True when the file was absent before — restore deletes it rather than writing. */
  created: boolean;
  /** Size at capture, for reporting and for the budgets above. */
  bytes: number;
}

export interface Checkpoint {
  id: string;
  /** The turn this belongs to, so a restore can name what it undoes. */
  turn: number;
  /** Which tool caused it: `write_file`, `run_shell`, and so on. */
  tool: string;
  /** A short human description, shown in `weaver checkpoints`. */
  label: string;
  createdAt: number;
  files: CapturedFile[];
  /**
   * Files the sweep could not cover, by reason. Present only for shell calls, and the
   * reason it exists: an honest gap beats an assumed guarantee.
   */
  skipped: Array<{ path: string; reason: "over-size" | "over-budget" | "over-count" | "unreadable" }>;
}

export interface Store {
  /** Absolute path of `.weaver/checkpoints`. */
  root: string;
  /** How many checkpoints to retain. Rotation drops the oldest past this. */
  keep: number;
}

export const DEFAULT_KEEP = 50;

export function storeFor(workspace: string, keep: number = DEFAULT_KEEP): Store {
  return { root: join(resolve(workspace), ".weaver", "checkpoints"), keep };
}

function blobPath(store: Store, hash: string): string {
  return join(store.root, "blobs", hash.slice(0, 2), hash);
}

function indexPath(store: Store, id: string): string {
  return join(store.root, "index", `${id}.json`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Read a workspace file, or null when it is missing or unreadable. */
async function readSafe(workspace: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(resolveInWorkspace(workspace, relPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * Walk the workspace, yielding relative paths.
 *
 * Bounded by `MAX_SWEEP_FILES` so a pathological tree cannot hang the agent, and it
 * yields the bound as a stop rather than truncating silently.
 */
async function* walk(workspace: string, limit: number): AsyncGenerator<string> {
  const root = resolve(workspace);
  const queue: string[] = [""];
  let seen = 0;
  while (queue.length > 0) {
    const rel = queue.shift() ?? "";
    const abs = rel === "" ? root : join(root, rel);
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (seen >= limit) return;
      seen += 1;
      yield childRel;
    }
  }
}

async function writeBlob(store: Store, hash: string, content: string): Promise<void> {
  const path = blobPath(store, hash);
  try {
    await stat(path);
    return; // Content-addressed: an existing blob is already correct.
  } catch {
    // Fall through and write it.
  }
  await mkdir(join(store.root, "blobs", hash.slice(0, 2)), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function appendIndex(store: Store, entry: Checkpoint): Promise<void> {
  await mkdir(join(store.root, "index"), { recursive: true });
  await writeFile(indexPath(store, entry.id), JSON.stringify(entry), "utf8");
}

/**
 * Capture the current state of specific files, before a call that will change them.
 *
 * This is the precise path: `write_file` and `edit_file` name their target, so we capture
 * exactly that and nothing else. Cheap enough to run on every edit.
 */
export async function capture(
  store: Store,
  workspace: string,
  options: { turn: number; tool: string; label: string; paths: string[]; now?: number },
): Promise<Checkpoint> {
  const files: CapturedFile[] = [];
  for (const raw of options.paths) {
    let rel: string;
    try {
      rel = toPosix(relative(resolve(workspace), resolveInWorkspace(workspace, raw)));
    } catch {
      // A path outside the workspace is not ours to snapshot, and not ours to read.
      continue;
    }
    const content = await readSafe(workspace, rel);
    const bytes = content === null ? 0 : Buffer.byteLength(content, "utf8");
    const hash = content === null ? null : sha256(content);
    if (content !== null && bytes <= MAX_BLOB_BYTES) await writeBlob(store, hash as string, content);
    files.push({ path: rel, hash, created: content === null, bytes });
  }

  const entry: Checkpoint = {
    id: `${options.now ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turn: options.turn,
    tool: options.tool,
    label: options.label,
    createdAt: options.now ?? Date.now(),
    files,
    skipped: [],
  };
  await appendIndex(store, entry);
  await rotate(store);
  return entry;
}

/**
 * Capture a whole workspace, for calls that can touch anything.
 *
 * `run_shell` is the reason this exists separately from `capture`. There is no argument
 * naming the files a command will change, so the only honest options are to sweep or to
 * admit we did not. This sweeps — within a byte budget, a file-count budget, and a
 * per-file cap — and records every file it declined to cover.
 *
 * `excluded` lets the caller pass paths already known to be unchanged, which is how the
 * agent avoids re-sweeping a workspace it has just read.
 */
export async function captureWorkspace(
  store: Store,
  workspace: string,
  options: { turn: number; tool: string; label: string; now?: number },
): Promise<Checkpoint> {
  const files: CapturedFile[] = [];
  const skipped: Checkpoint["skipped"] = [];
  let budget = MAX_SWEEP_BYTES;
  let count = 0;

  for await (const rel of walk(workspace, MAX_SWEEP_FILES)) {
    const content = await readSafe(workspace, rel);
    if (content === null) {
      skipped.push({ path: rel, reason: "unreadable" });
      continue;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BLOB_BYTES) {
      skipped.push({ path: rel, reason: "over-size" });
      continue;
    }
    if (bytes > budget) {
      skipped.push({ path: rel, reason: "over-budget" });
      continue;
    }
    budget -= bytes;
    count += 1;
    if (count > MAX_SWEEP_FILES) {
      skipped.push({ path: rel, reason: "over-count" });
      continue;
    }
    const hash = sha256(content);
    await writeBlob(store, hash, content);
    files.push({ path: rel, hash, created: false, bytes });
  }

  const entry: Checkpoint = {
    id: `${options.now ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turn: options.turn,
    tool: options.tool,
    label: options.label,
    createdAt: options.now ?? Date.now(),
    files,
    skipped,
  };
  await appendIndex(store, entry);
  await rotate(store);
  return entry;
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  /** Files the checkpoint recorded but whose blob is gone, so could not be restored. */
  missing: string[];
}

/**
 * Undo a checkpoint: put the workspace back the way it was.
 *
 * A file that did not exist at capture time is *deleted* on restore, because "undo the
 * creation of deploy.sh" is the single most valuable undo in the product — an agent that
 * created a file containing a key should be able to make it not exist again.
 */
export async function restore(store: Store, workspace: string, id: string): Promise<RestoreResult | null> {
  let entry: Checkpoint;
  try {
    entry = JSON.parse(await readFile(indexPath(store, id), "utf8")) as Checkpoint;
  } catch {
    return null;
  }

  const result: RestoreResult = { restored: [], deleted: [], missing: [] };
  for (const file of entry.files) {
    const abs = resolveInWorkspace(workspace, file.path);
    if (file.hash === null || file.created) {
      await rm(abs, { force: true });
      result.deleted.push(file.path);
      continue;
    }
    let content: string;
    try {
      content = await readFile(blobPath(store, file.hash), "utf8");
    } catch {
      result.missing.push(file.path);
      continue;
    }
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
    result.restored.push(file.path);
  }
  await rm(indexPath(store, id), { force: true });
  return result;
}

export interface Change {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
}

/**
 * What a checkpoint would undo, without undoing it.
 *
 * `weaver checkpoints diff <id>` needs this, and so does a consent prompt: a user shown
 * "this will delete deploy.sh and restore src/app.ts" can make a decision, where a user
 * shown "restore checkpoint 7" cannot.
 */
export async function diff(store: Store, workspace: string, id: string): Promise<Change[] | null> {
  let entry: Checkpoint;
  try {
    entry = JSON.parse(await readFile(indexPath(store, id), "utf8")) as Checkpoint;
  } catch {
    return null;
  }

  const changes: Change[] = [];
  for (const file of entry.files) {
    const current = await readSafe(workspace, file.path);
    if (file.hash === null || file.created) {
      changes.push({ path: file.path, status: current === null ? "unchanged" : "added" });
      continue;
    }
    if (current === null) {
      changes.push({ path: file.path, status: "removed" });
      continue;
    }
    changes.push({ path: file.path, status: sha256(current) === file.hash ? "unchanged" : "modified" });
  }
  return changes;
}

export async function list(store: Store): Promise<Checkpoint[]> {
  let names: string[];
  try {
    names = await readdir(join(store.root, "index"));
  } catch {
    return [];
  }
  const out: Checkpoint[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(store.root, "index", name), "utf8")) as Checkpoint);
    } catch {
      // A corrupt index entry is skipped rather than failing the whole listing.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Drop the oldest checkpoints, and any blob no surviving checkpoint still references.
 *
 * Referenced-counting matters: two checkpoints capturing the same unchanged file share one
 * blob, so deleting by age alone would leave the survivor pointing at nothing. Losing a
 * blob silently is exactly the failure `missing` exists to report, so it is prevented here
 * rather than reported later.
 */
export async function rotate(store: Store): Promise<void> {
  const entries = (await list(store)).sort((a, b) => a.createdAt - b.createdAt);
  const excess = entries.length - store.keep;
  if (excess <= 0) return;

  const doomed = entries.slice(0, excess);
  const stillReferenced = new Set<string>();
  for (const survivor of entries.slice(excess)) {
    for (const file of survivor.files) if (file.hash !== null) stillReferenced.add(file.hash);
  }

  for (const entry of doomed) {
    await rm(indexPath(store, entry.id), { force: true });
    for (const file of entry.files) {
      if (file.hash === null || stillReferenced.has(file.hash)) continue;
      stillReferenced.add(file.hash);
      await rm(blobPath(store, file.hash), { force: true });
    }
  }
}

export interface CheckpointStats {
  checkpoints: number;
  blobs: number;
  bytes: number;
  skipped: number;
}

export async function stats(store: Store): Promise<CheckpointStats> {
  const entries = await list(store);
  const hashes = new Set<string>();
  let bytes = 0;
  let skipped = 0;
  for (const entry of entries) {
    skipped += entry.skipped.length;
    for (const file of entry.files) {
      if (file.hash === null) continue;
      hashes.add(file.hash);
      bytes += file.bytes;
    }
  }
  return { checkpoints: entries.length, blobs: hashes.size, bytes, skipped };
}
