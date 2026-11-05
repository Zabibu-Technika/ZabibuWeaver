// Integrations.
//
// These tests never touch the network or the real `gh`: the runner is injected, so the
// parsing, the argument construction, and the selection file are all exercised offline.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubIntegration, parseGhAccounts } from "./github.ts";
import { vercelIntegration, parseVercelTeams } from "./vercel.ts";
import { manifestIntegration, parseManifest } from "./manifest.ts";
import { activeAccount, detectIntegrations } from "./registry.ts";
import { readSelection, writeSelection } from "./selection.ts";
import type { CommandRunner, RunResult } from "./types.ts";

function ok(stdout: string): RunResult {
  return { ok: true, code: 0, stdout, stderr: "", ms: 1, timedOut: false };
}

function fail(stderr: string): RunResult {
  return { ok: false, code: 1, stdout: "", stderr, ms: 1, timedOut: false };
}

const GH_HOSTS = JSON.stringify({
  hosts: {
    "github.com": [
      { login: "alice", active: true, host: "github.com", state: "success", scopes: "repo" },
      { login: "bob", active: false, host: "github.com", state: "success", scopes: "repo, read:org" },
    ],
  },
});

test("GitHub accounts are parsed with host-qualified ids and the active one first", () => {
  const accounts = parseGhAccounts(GH_HOSTS);
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0]?.id, "github.com#alice");
  assert.equal(accounts[0]?.active, true);
  assert.equal(accounts[1]?.label, "bob");
  assert.equal(accounts[1]?.host, "github.com");
});

test("switching GitHub uses the host and the user explicitly", async () => {
  const calls: string[] = [];
  const runner: CommandRunner = async (binary, args) => {
    calls.push(`${binary} ${args.join(" ")}`);
    if (args[0] === "--version") return ok("gh version 2.102.0");
    if (args[0] === "auth" && args[1] === "status") return ok(GH_HOSTS);
    if (args[0] === "auth" && args[1] === "switch") return ok("");
    if (args[0] === "api") return ok(JSON.stringify({ name: "Alice", email: null, login: "alice", id: 42 }));
    return fail("unexpected");
  };

  const github = githubIntegration(runner);
  assert.equal(await github.available(), true);
  const accounts = await github.accounts();
  const bob = accounts.find((account) => account.label === "bob");
  assert.ok(bob !== undefined);

  const result = await github.switchTo(bob);
  assert.equal(result.ok, true, result.message);
  assert.ok(calls.includes("gh auth switch --hostname github.com --user bob"));

  assert.ok(github.identity !== undefined);
  const identity = await github.identity(accounts[0]!);
  assert.equal(identity.name, "Alice");
  assert.equal(identity.email, "42+alice@users.noreply.github.com", "a private email falls back to noreply");
});

test("a manifest adapter substitutes {account} and parses the account list", async () => {
  const calls: string[] = [];
  const runner: CommandRunner = async (binary, args) => {
    calls.push(`${binary} ${args.join(" ")}`);
    if (args[0] === "--version") return ok("acme 1.0");
    if (args[0] === "accounts") {
      return ok(JSON.stringify([{ id: "work", label: "Work", active: true }, { id: "personal", label: "Personal" }]));
    }
    if (args[0] === "use") return ok("");
    return fail("unexpected");
  };

  const acme = manifestIntegration(
    { id: "acme", label: "Acme", binary: "acme", accounts: ["accounts", "--json"], switch: ["use", "{account}"] },
    runner,
  );

  assert.equal(await acme.available(), true);
  const accounts = await acme.accounts();
  assert.equal(accounts.length, 2);
  assert.equal(accounts[1]?.id, "personal");

  const result = await acme.switchTo(accounts[1]!);
  assert.equal(result.ok, true, result.message);
  assert.ok(calls.includes("acme use personal"));
});

test("Vercel teams are parsed from JSON and from the text table", () => {
  const json = parseVercelTeams(JSON.stringify([{ id: "team_1", slug: "acme", name: "Acme" }]));
  assert.equal(json[0]?.id, "acme");
  assert.equal(json[0]?.label, "Acme");

  const table = parseVercelTeams("id         name    slug\nteam_1     Acme    acme\nteam_2     Beta    beta");
  assert.deepEqual(table.map((account) => account.id), ["acme", "beta"]);
  assert.equal(table[0]?.label, "Acme");
});

test("the Vercel adapter lists teams plus the personal account and switches by scope", async () => {
  const calls: string[] = [];
  const runner: CommandRunner = async (binary, args) => {
    calls.push(`${binary} ${args.join(" ")}`);
    if (args[0] === "--version") return ok("Vercel CLI 48.0.0");
    if (args[0] === "teams" && args[2] === "--json") {
      return ok(JSON.stringify([{ id: "team_1", slug: "acme", name: "Acme" }]));
    }
    if (args[0] === "whoami") return ok("alice");
    if (args[0] === "switch") return ok("");
    return fail("unexpected");
  };

  const vercel = vercelIntegration(runner);
  assert.equal(await vercel.available(), true);
  const accounts = await vercel.accounts();
  assert.deepEqual(accounts.map((account) => account.id).sort(), ["acme", "alice"]);

  const target = accounts.find((account) => account.id === "acme");
  assert.ok(target !== undefined);
  const result = await vercel.switchTo(target);
  assert.equal(result.ok, true, result.message);
  assert.ok(calls.includes("vercel switch acme"));
});

test("a malformed manifest is rejected instead of half-loaded", () => {
  assert.equal(parseManifest({ id: "x", binary: "x" }), null);
  assert.equal(parseManifest({ id: "x", binary: "x", accounts: [], switch: [] })?.id, "x");
});

test("the selection is remembered per workspace and self-ignored in git", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weaver-selection-"));
  try {
    await writeSelection(dir, "github", "github.com#alice");
    await writeSelection(dir, "vercel", "acme");
    assert.deepEqual(await readSelection(dir), { github: "github.com#alice", vercel: "acme" });

    const ignore = await readFile(join(dir, ".weaver", ".gitignore"), "utf8");
    assert.equal(ignore.trim(), "*");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the registry reports only integrations that are actually installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weaver-integrations-"));
  const home = join(dir, "home");
  try {
    const runner: CommandRunner = async (binary, args) => {
      if (binary === "gh" && args[0] === "--version") return ok("gh version 2.102.0");
      if (binary === "gh" && args[0] === "auth" && args[1] === "status") return ok(GH_HOSTS);
      if (binary === "vercel" && args[0] === "--version") return ok("Vercel CLI 48.0.0");
      if (binary === "vercel" && args[0] === "teams" && args[2] === "--json") {
        return ok(JSON.stringify([{ id: "team_1", slug: "acme", name: "Acme" }]));
      }
      if (binary === "vercel" && args[0] === "whoami") return ok("alice");
      return fail("unexpected");
    };

    const detected = await detectIntegrations(dir, home, runner);
    assert.deepEqual(detected.map((entry) => entry.integration.id), ["github", "vercel"]);
    assert.equal(detected[0]?.accounts.length, 2);
    assert.equal(activeAccount(detected[0]!)?.label, "alice");
    assert.deepEqual(detected[1]?.accounts.map((account) => account.id).sort(), ["acme", "alice"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
