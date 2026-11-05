// Vercel CLI.
//
// Vercel's model is a personal account plus teams (scopes), and `vercel switch <scope>`
// changes which one deploys. The CLI does not expose a stable "who is active" field on
// every version, so this adapter does not invent one: it lists what it can read, marks the
// personal account active only when there are no teams, and lets the workspace's remembered
// selection be the tie-breaker.
//
// `teams ls --json` is tried first. If the installed CLI does not support it, the plain
// table is parsed. A user whose CLI differs can override this with a manifest in
// `.weaver/integrations/vercel.json`.
import { run as defaultRun } from "./runner.ts";
import type { Account, CommandRunner, Integration, IntegrationResult } from "./types.ts";

interface VercelTeam {
  id?: string;
  slug?: string;
  name?: string;
  active?: boolean;
}

/** Teams from a JSON array, or from the plain table `vercel teams ls` prints. */
export function parseVercelTeams(stdout: string): Account[] {
  const text = stdout.trim();
  if (text.length === 0) return [];

  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { teams?: unknown }).teams;
    if (Array.isArray(list)) {
      const accounts: Account[] = [];
      for (const item of list) {
        if (item === null || typeof item !== "object") continue;
        const team = item as VercelTeam;
        const id = team.slug ?? team.id ?? team.name ?? "";
        if (id.length === 0) continue;
        accounts.push({
          id,
          label: team.name ?? team.slug ?? id,
          active: team.active === true,
          detail: team.id,
        });
      }
      return accounts;
    }
  } catch {
    // Not JSON; parse the table below.
  }

  const accounts: Account[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/^(id|name|slug)\b/i.test(line)) continue;
    if (/^(fetching|error|no teams)/i.test(line)) continue;

    // Columns are usually separated by two or more spaces; fall back to any run of spaces.
    const spaced = line.split(/\s{2,}|\t/).map((part) => part.trim()).filter((part) => part.length > 0);
    const columns = spaced.length >= 2 ? spaced : line.split(/\s+/);
    const id = columns[2] ?? columns[0] ?? "";
    const label = columns[1] ?? id;
    if (id.length === 0) continue;
    accounts.push({ id, label, active: false, detail: columns[0] });
  }
  return accounts;
}

function firstLine(text: string, fallback: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? fallback;
}

export function vercelIntegration(runner: CommandRunner = defaultRun): Integration {
  return {
    id: "vercel",
    label: "Vercel",
    binary: "vercel",

    async available(): Promise<boolean> {
      return (await runner("vercel", ["--version"])).ok;
    },

    async accounts(): Promise<Account[]> {
      let accounts: Account[] = [];

      const json = await runner("vercel", ["teams", "ls", "--json"]);
      if (json.ok) accounts = parseVercelTeams(json.stdout);

      if (accounts.length === 0) {
        const table = await runner("vercel", ["teams", "ls"]);
        if (table.ok) accounts = parseVercelTeams(table.stdout);
      }

      const who = await runner("vercel", ["whoami"]);
      if (who.ok) {
        const raw = who.stdout
          .trim()
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .pop() ?? "";
        const user = raw.replace(/^.*\bas\s+/i, "").trim();
        if (user.length > 0 && !accounts.some((account) => account.id === user)) {
          accounts.push({ id: user, label: user, active: accounts.length === 0, detail: "personal" });
        }
      }

      return accounts;
    },

    async switchTo(account: Account): Promise<IntegrationResult> {
      const result = await runner("vercel", ["switch", account.id]);
      return result.ok
        ? { ok: true, message: `Vercel is now using ${account.label}` }
        : { ok: false, message: firstLine(result.stderr, `could not switch Vercel to ${account.label}`) };
    },
  };
}
