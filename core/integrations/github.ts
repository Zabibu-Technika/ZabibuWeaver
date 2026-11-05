// GitHub CLI.
//
// `gh auth status --json hosts` is the machine interface: one array per host, each entry
// with `login`, `active`, and the token's scopes. That is enough to build an account
// switcher without scraping human output or reading the keyring ourselves.
import { run as defaultRun } from "./runner.ts";
import type { Account, CommandRunner, Integration, IntegrationResult } from "./types.ts";

interface GhAccount {
  login?: string;
  active?: boolean;
  host?: string;
  state?: string;
  scopes?: string;
  gitProtocol?: string;
}

interface GhPayload {
  hosts?: Record<string, GhAccount[]>;
}

export function parseGhAccounts(stdout: string): Account[] {
  let payload: GhPayload;
  try {
    payload = JSON.parse(stdout) as GhPayload;
  } catch {
    return [];
  }

  const accounts: Account[] = [];
  for (const [host, list] of Object.entries(payload.hosts ?? {})) {
    for (const item of list) {
      const login = item.login ?? "";
      if (login.length === 0) continue;
      accounts.push({
        id: `${host}#${login}`,
        label: login,
        host,
        active: item.active === true,
        detail: item.scopes !== undefined && item.scopes.length > 0 ? item.scopes : undefined,
      });
    }
  }

  return accounts.sort((a, b) => (a.active === b.active ? a.label.localeCompare(b.label) : a.active ? -1 : 1));
}

function splitId(id: string): { host: string; login: string } {
  const separator = id.indexOf("#");
  if (separator === -1) return { host: "github.com", login: id };
  return { host: id.slice(0, separator), login: id.slice(separator + 1) };
}

function firstLine(text: string, fallback: string): string {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? fallback;
}

export function githubIntegration(runner: CommandRunner = defaultRun): Integration {
  return {
    id: "github",
    label: "GitHub",
    binary: "gh",

    async available(): Promise<boolean> {
      return (await runner("gh", ["--version"])).ok;
    },

    async accounts(): Promise<Account[]> {
      const result = await runner("gh", ["auth", "status", "--json", "hosts"]);
      return result.ok ? parseGhAccounts(result.stdout) : [];
    },

    async switchTo(account: Account): Promise<IntegrationResult> {
      const { host, login } = splitId(account.id);
      const result = await runner("gh", ["auth", "switch", "--hostname", host, "--user", login]);
      return result.ok
        ? { ok: true, message: `GitHub is now using ${login} on ${host}` }
        : { ok: false, message: firstLine(result.stderr, `could not switch to ${login}`) };
    },

    async identity(account: Account): Promise<{ name: string | null; email: string | null }> {
      const { host, login } = splitId(account.id);
      const result = await runner(
        "gh",
        ["api", "user", "--jq", "{name: .name, email: .email, login: .login, id: .id}"],
        { env: { ...process.env, GH_HOST: host } },
      );
      if (!result.ok) return { name: login, email: null };

      try {
        const profile = JSON.parse(result.stdout) as { name?: string | null; email?: string | null; login?: string; id?: number };
        const resolvedLogin = profile.login ?? login;
        const name = profile.name !== null && profile.name !== undefined && profile.name.length > 0 ? profile.name : resolvedLogin;
        const email =
          profile.email !== null && profile.email !== undefined && profile.email.length > 0
            ? profile.email
            : profile.id !== undefined
              ? `${profile.id}+${resolvedLogin}@users.noreply.github.com`
              : `${resolvedLogin}@users.noreply.github.com`;
        return { name, email };
      } catch {
        return { name: login, email: null };
      }
    },
  };
}
