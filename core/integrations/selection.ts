// Which account this workspace uses.
//
// The CLI remains the source of truth for what is active; this file is the workspace's
// memory of what the human chose, so a project does not silently drift back to a default
// account between sessions. If the CLI and the file disagree, the UI shows both.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function selectionPath(workspace: string): string {
  return join(resolve(workspace), ".weaver", "integrations.json");
}

export async function readSelection(workspace: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(selectionPath(workspace), "utf8")) as { selected?: unknown };
    if (parsed.selected === null || typeof parsed.selected !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.selected as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Keep the agent directory out of git, including on a machine where no checkpoint ran. */
async function ensureSelfIgnored(workspace: string): Promise<void> {
  const directory = join(resolve(workspace), ".weaver");
  const path = join(directory, ".gitignore");
  try {
    await stat(path);
    return;
  } catch {
    // Write it below.
  }
  await mkdir(directory, { recursive: true });
  await writeFile(path, "*\n", "utf8");
}

export async function writeSelection(workspace: string, integration: string, account: string): Promise<void> {
  const path = selectionPath(workspace);
  const selected = await readSelection(workspace);
  selected[integration] = account;
  await mkdir(dirname(path), { recursive: true });
  await ensureSelfIgnored(workspace);
  await writeFile(path, `${JSON.stringify({ selected }, null, 2)}\n`, "utf8");
}
