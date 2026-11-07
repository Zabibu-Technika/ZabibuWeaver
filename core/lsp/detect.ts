// Where the LSP tool finds a server.
//
// Configuration wins, then a small set of conventional executables. The tool never installs
// a language server: that is a user decision and a supply-chain choice, not something an
// agent should do silently.
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { LspServerConfig } from "./client.ts";

const DEFAULTS: LspServerConfig[] = [
  { name: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] },
  { name: "python", command: "pyright-langserver", args: ["--stdio"], extensions: [".py"] },
  { name: "rust", command: "rust-analyzer", extensions: [".rs"] },
  { name: "go", command: "gopls", extensions: [".go"] },
];

export interface LspConfigFile {
  servers?: LspServerConfig[];
}

export async function loadLspServers(workspace: string): Promise<LspServerConfig[]> {
  const path = join(workspace, ".weaver", "lsp.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as LspConfigFile;
    if (Array.isArray(parsed.servers)) {
      return parsed.servers.filter(
        (server): server is LspServerConfig =>
          Boolean(server) &&
          typeof server.name === "string" &&
          typeof server.command === "string" &&
          Array.isArray(server.extensions),
      );
    }
  } catch {
    // No project configuration: use the conventional servers.
  }
  return DEFAULTS;
}

export async function serverFor(workspace: string, path: string): Promise<LspServerConfig | null> {
  const extension = extname(path).toLowerCase();
  const servers = await loadLspServers(workspace);
  return servers.find((server) => server.extensions.map((entry) => entry.toLowerCase()).includes(extension)) ?? null;
}
