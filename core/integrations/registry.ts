// The registry: what is installed, which accounts it has, and which one this workspace uses.
//
// Detection is allowed to be empty. A machine without `gh` is normal, and a machine with
// `vercel` installed but not logged in is normal too. The UI says so rather than pretending
// the integration exists.
import { githubIntegration } from "./github.ts";
import { vercelIntegration } from "./vercel.ts";
import { loadManifests, manifestIntegration } from "./manifest.ts";
import { readSelection, writeSelection } from "./selection.ts";
import type { Account, CommandRunner, Integration, IntegrationResult } from "./types.ts";

export interface DetectedIntegration {
  integration: Integration;
  accounts: Account[];
  /** The account this workspace asked for, if any. May differ from the CLI's active one. */
  selected: string | null;
}

export async function detectIntegrations(
  workspace: string,
  home: string,
  runner?: CommandRunner,
): Promise<DetectedIntegration[]> {
  const specs = await loadManifests(workspace, home);
  const integrations: Integration[] = [githubIntegration(runner), vercelIntegration(runner)];
  for (const spec of specs) integrations.push(manifestIntegration(spec, runner));

  const selected = await readSelection(workspace);
  const detected: DetectedIntegration[] = [];

  for (const integration of integrations) {
    if (!(await integration.available())) continue;
    detected.push({
      integration,
      accounts: await integration.accounts(),
      selected: selected[integration.id] ?? null,
    });
  }

  return detected;
}

/**
 * Switch the CLI's active account and remember the choice.
 *
 * The memory is written only after the CLI reports success. A failed switch must not leave
 * the workspace believing it is on an account it is not using.
 */
export async function switchAccount(
  workspace: string,
  detected: DetectedIntegration,
  account: Account,
): Promise<IntegrationResult> {
  const result = await detected.integration.switchTo(account);
  if (result.ok) await writeSelection(workspace, detected.integration.id, account.id);
  return result;
}

/** The account the CLI says is active; fall back to the workspace's remembered choice. */
export function activeAccount(detected: DetectedIntegration): Account | null {
  return (
    detected.accounts.find((account) => account.active) ??
    detected.accounts.find((account) => account.id === detected.selected) ??
    null
  );
}
