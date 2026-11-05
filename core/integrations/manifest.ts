// Manifest-driven adapters, for CLIs that are not covered by a dedicated adapter.
//
// GitHub and Vercel have first-class adapters because their account semantics are known.
// Any other CLI with accounts can declare the contract in JSON instead of waiting for a
// release:
//
//   {
//     "id": "acme",
//     "label": "Acme",
//     "binary": "acme",
//     "accounts": ["accounts", "--json"],
//     "switch": ["use", "{account}"],
//     "identity": { "name": ["whoami", "--name"], "email": ["whoami", "--email"] }
//   }
//
// `accounts` must print either an array or `{ "accounts": [...] }`, with `id` (or `name`)
// and `active`. A manifest can live in `~/.weaver/integrations/` or
// `<workspace>/.weaver/integrations/`; the project copy wins.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run as defaultRun } from "./runner.ts";
import type { Account, CommandRunner, Integration, IntegrationResult } from "./types.ts";

export interface ManifestSpec {
  id: string;
  label: string;
  binary: string;
  accounts: string[];
  switch: string[];
  identity?: { name: string[]; email: string[] };
}

// GitHub and Vercel have dedicated adapters; manifests are for everything else.

function asStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

export function parseManifest(value: unknown): ManifestSpec | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const binary = typeof record.binary === "string" ? record.binary.trim() : "";
  const accounts = asStrings(record.accounts);
  const switchArgs = asStrings(record.switch);
  if (id.length === 0 || binary.length === 0 || accounts === null || switchArgs === null) return null;

  let identity: ManifestSpec["identity"];
  if (record.identity !== null && typeof record.identity === "object") {
    const raw = record.identity as Record<string, unknown>;
    const name = asStrings(raw.name);
    const email = asStrings(raw.email);
    if (name !== null && email !== null) identity = { name, email };
  }

  const spec: ManifestSpec = {
    id,
    label: typeof record.label === "string" && record.label.trim().length > 0 ? record.label.trim() : id,
    binary,
    accounts,
    switch: switchArgs,
  };
  if (identity !== undefined) spec.identity = identity;
  return spec;
}

export async function loadManifests(workspace: string, home: string): Promise<ManifestSpec[]> {
  const specs = new Map<string, ManifestSpec>();

  for (const directory of [join(home, "integrations"), join(workspace, ".weaver", "integrations")]) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as unknown;
        const spec = parseManifest(parsed);
        if (spec !== null) specs.set(spec.id, spec);
      } catch {
        // A malformed manifest is skipped; it must not take the registry down with it.
      }
    }
  }

  return [...specs.values()];
}

function firstLine(text: string): string | null {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

export function manifestIntegration(spec: ManifestSpec, runner: CommandRunner = defaultRun): Integration {
  return {
    id: spec.id,
    label: spec.label,
    binary: spec.binary,

    async available(): Promise<boolean> {
      if ((await runner(spec.binary, ["--version"])).ok) return true;
      return (await runner(spec.binary, ["--help"])).ok;
    },

    async accounts(): Promise<Account[]> {
      const result = await runner(spec.binary, spec.accounts);
      if (!result.ok) return [];

      try {
        const parsed = JSON.parse(result.stdout) as unknown;
        const list = Array.isArray(parsed) ? parsed : (parsed as { accounts?: unknown }).accounts;
        if (!Array.isArray(list)) return [];

        const accounts: Account[] = [];
        for (const item of list) {
          if (item === null || typeof item !== "object") continue;
          const record = item as Record<string, unknown>;
          const id =
            typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : "";
          if (id.length === 0) continue;
          accounts.push({
            id,
            label: typeof record.label === "string" ? record.label : id,
            host: typeof record.host === "string" ? record.host : undefined,
            active: record.active === true,
            detail: typeof record.detail === "string" ? record.detail : undefined,
          });
        }
        return accounts;
      } catch {
        return [];
      }
    },

    async switchTo(account: Account): Promise<IntegrationResult> {
      const args = spec.switch.map((argument) => (argument === "{account}" ? account.id : argument));
      const result = await runner(spec.binary, args);
      return result.ok
        ? { ok: true, message: `${spec.label} is now using ${account.label}` }
        : { ok: false, message: firstLine(result.stderr) ?? `could not switch ${spec.label} to ${account.label}` };
    },

    async identity(account: Account): Promise<{ name: string | null; email: string | null }> {
      if (spec.identity === undefined) return { name: null, email: null };
      const name = await runner(spec.binary, spec.identity.name);
      const email = await runner(spec.binary, spec.identity.email);
      return {
        name: name.ok ? name.stdout.trim() || null : null,
        email: email.ok ? email.stdout.trim() || null : null,
      };
    },
  };
}
