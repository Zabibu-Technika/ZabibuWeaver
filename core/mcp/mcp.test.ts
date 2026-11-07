import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeMcp, loadMcpTools, mcpStatus } from "./tools.ts";

const fake = join(import.meta.dirname, "fake-server.mjs");

async function withWorkspace(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "weaver-mcp-"));
  try {
    await mkdir(join(dir, ".weaver"), { recursive: true });
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(
      join(dir, ".weaver", "mcp.json"),
      JSON.stringify({
        servers: {
          fake: { command: process.execPath, args: [fake] },
        },
      }),
      "utf8",
    );
    await body(dir);
  } finally {
    await closeMcp();
    await rm(dir, { recursive: true, force: true });
  }
}

test("configured MCP tools are exposed with namespaced names and safe capabilities", async () => {
  await withWorkspace(async (dir) => {
    const tools = await loadMcpTools(dir, join(dir, "home"));
    assert.equal(tools.length, 2);

    const echo = tools.find((tool) => tool.name.endsWith("__echo"));
    const note = tools.find((tool) => tool.name.endsWith("__write_note"));
    assert.ok(echo);
    assert.ok(note);
    assert.equal(echo?.capability, "read");
    assert.equal(echo?.mutating, false);
    assert.equal(note?.capability, "unbounded");
    assert.equal(note?.mutating, true);
    assert.equal(echo?.ingest, "external");
  });
});

test("an MCP tool call returns the server's text", async () => {
  await withWorkspace(async (dir) => {
    const tools = await loadMcpTools(dir, join(dir, "home"));
    const echo = tools.find((tool) => tool.name.endsWith("__echo"));
    assert.ok(echo);
    const result = await echo.run({ text: "hello" }, { workspace: dir });
    assert.equal(result.ok, true);
    assert.equal(result.output, "echo: hello");
  });
});

test("mcp status reports configured servers and tools", async () => {
  await withWorkspace(async (dir) => {
    const status = await mcpStatus(dir, join(dir, "home"));
    assert.equal(status.length, 1);
    assert.equal(status[0]?.server, "fake");
    assert.equal(status[0]?.tools.length, 2);
  });
});

test("no configuration means no MCP tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weaver-mcp-empty-"));
  try {
    await mkdir(join(dir, "home"), { recursive: true });
    assert.deepEqual(await loadMcpTools(dir, join(dir, "home")), []);
  } finally {
    await closeMcp();
    await rm(dir, { recursive: true, force: true });
  }
});
