// External CLIs as first-class integrations.
//
// GitHub CLI, Vercel, and anything else with accounts are not "plugins": they are the
// identity layer for what the agent produces. Pushing code under the wrong account is not
// a cosmetic mistake, so the selection is explicit, persisted per workspace, and shown.
//
// The adapter contract is deliberately small. A CLI that can list its accounts as JSON and
// switch by name can be driven by a manifest; GitHub gets a first-class adapter because
// `gh auth status --json hosts` is a stable machine interface.
export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

export type CommandRunner = (
  binary: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

export interface Account {
  /** Stable id. For GitHub this is `host#login`. */
  id: string;
  label: string;
  host?: string;
  active: boolean;
  detail?: string;
}

export interface IntegrationResult {
  ok: boolean;
  message: string;
}

export interface Integration {
  id: string;
  label: string;
  /** The executable this adapter drives. */
  binary: string;
  available(): Promise<boolean>;
  accounts(): Promise<Account[]>;
  switchTo(account: Account): Promise<IntegrationResult>;
  /** The commit identity behind an account, when the CLI can tell us. */
  identity?(account: Account): Promise<{ name: string | null; email: string | null }>;
}
