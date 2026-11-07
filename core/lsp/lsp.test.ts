import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lspTool } from "./tool.ts";

const fake = join(import.meta.dirname, "fake-server.mjs");

async function withWorkspace(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-lsp-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, ".weaver"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export const answer = 42;\n", "utf8");
    await writeFile(
      join(dir, ".weaver", "lsp.json"),
      JSON.stringify({
        servers: [
          {
            name: "fake",
            command: process.execPath,
            args: [fake],
            extensions: [".ts"],
          },
        ],
      }),
      "utf8",
    );
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("lsp diagnostics come from the configured language server", async () => {
  await withWorkspace(async (dir) => {
    const result = await lspTool.run({ action: "diagnostics", path: "src/app.ts" }, { workspace: dir });
    assert.equal(result.ok, true);
    assert.match(result.output, /fake warning/);
    assert.match(result.output, /warning/);
  });
});

test("lsp definition returns a location", async () => {
  await withWorkspace(async (dir) => {
    const result = await lspTool.run(
      { action: "definition", path: "src/app.ts", line: 0, character: 0 },
      { workspace: dir },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /app\.ts:1:1/);
  });
});

test("lsp references returns every location", async () => {
  await withWorkspace(async (dir) => {
    const result = await lspTool.run(
      { action: "references", path: "src/app.ts", line: 0, character: 0 },
      { workspace: dir },
    );
    assert.equal(result.ok, true);
    const lines = result.output.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(result.output, /app\.ts:1:1/);
    assert.match(result.output, /app\.ts:2:5/);
  });
});

test("lsp hover returns the server's contents", async () => {
  await withWorkspace(async (dir) => {
    const result = await lspTool.run(
      { action: "hover", path: "src/app.ts", line: 0, character: 0 },
      { workspace: dir },
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /fake hover/);
  });
});

test("lsp rejects an unknown action", async () => {
  await withWorkspace(async (dir) => {
    const result = await lspTool.run({ action: "rename", path: "src/app.ts" }, { workspace: dir });
    assert.equal(result.ok, false);
    assert.match(result.output, /action must be one of/);
  });
});

test("lsp explains a missing server instead of guessing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weaver-lsp-empty-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "app.ts"), "export const answer = 42;\n", "utf8");
    const result = await lspTool.run({ action: "diagnostics", path: "src/app.ts" }, { workspace: dir });
    assert.equal(result.ok, false);
    assert.match(result.output, /could not answer|no server configured/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
