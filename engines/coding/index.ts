// The coding engine's public manifest.
//
// This is deliberately a manifest and not a second copy of the tools. The runnable
// implementation lives in `src/` while the architecture is migrated; duplicating tool
// code into `engines/coding` would create two sources of truth, and the first thing to
// drift would be a security-relevant default.
//
// What this file *does* own is the engine's contract: which tools it considers part of
// the coding axis, and whether a change from this engine must pass proof-of-state
// verification before it can be called done.
export interface EngineManifest {
  id: string;
  axis: "mono" | "multi";
  description: string;
  /** Tool names this engine owns. Matches the registry in src/tools/index.ts. */
  tools: string[];
  /** True when a mutating turn must run the project's checks before it is "done". */
  requiresVerification: boolean;
  /** Tools whose effects leave the machine, and therefore need a compensation plan. */
  externalActions: string[];
}

export const CODING_ENGINE: EngineManifest = {
  id: "coding",
  axis: "mono",
  description:
    "Elite software engineering: read, edit, search, run, verify. Narrow on purpose — the value is depth and a deterministic gate, not breadth.",
  tools: ["read_file", "write_file", "edit_file", "list_dir", "glob_files", "grep", "run_shell", "lsp", "subagent"],
  requiresVerification: true,
  externalActions: ["run_shell"],
};

export function owns(tool: string): boolean {
  return CODING_ENGINE.tools.includes(tool);
}
