// The agent-facing LSP tool. Read-only by contract.
import type { ToolDef, ToolOutcome } from "../contracts/tool.ts";
import { formatDiagnostics, formatLocations, LspClient } from "./client.ts";
import { serverFor } from "./detect.ts";

const ACTIONS = ["diagnostics", "definition", "references", "hover"] as const;
type Action = (typeof ACTIONS)[number];

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asPosition(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function clip(text: string, limit = 8000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [truncated]`;
}

export const lspTool: ToolDef = {
  name: "lsp",
  description:
    "Ask the project's language server for diagnostics, a definition, references, or hover information. Read-only; requires a configured language server.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ACTIONS,
        description: "diagnostics | definition | references | hover",
      },
      path: { type: "string", description: "File path relative to the workspace." },
      line: { type: "number", description: "Zero-based line for definition/references/hover." },
      character: { type: "number", description: "Zero-based character for definition/references/hover." },
    },
    required: ["action", "path"],
  },
  mutating: false,
  capability: "read",
  ingest: "local",
  async run(input, ctx): Promise<ToolOutcome> {
    const action = asString(input.action) as Action | null;
    const path = asString(input.path);
    if (action === null || !ACTIONS.includes(action)) {
      return { ok: false, output: `lsp: action must be one of ${ACTIONS.join(", ")}` };
    }
    if (path === null) return { ok: false, output: "lsp: path is required" };

    const server = await serverFor(ctx.workspace, path);
    if (server === null) {
      return {
        ok: false,
        output:
          `lsp: no server configured for ${path}. Add .weaver/lsp.json with a server ` +
          `whose "extensions" includes this file type.`,
      };
    }

    const client = new LspClient(server, ctx.workspace);
    try {
      await client.initialize();
      const uri = await client.open(path);

      if (action === "diagnostics") {
        const diagnostics = await client.diagnostics(uri);
        return { ok: true, output: clip(formatDiagnostics(path, diagnostics)) };
      }

      if (input.line === undefined || input.character === undefined) {
        return { ok: false, output: `lsp: line and character are required for ${action}` };
      }
      const position = { line: asPosition(input.line), character: asPosition(input.character) };

      if (action === "definition") {
        return { ok: true, output: clip(formatLocations(await client.definition(uri, position))) };
      }
      if (action === "references") {
        return { ok: true, output: clip(formatLocations(await client.references(uri, position))) };
      }

      const hover = await client.hover(uri, position);
      return { ok: true, output: clip(hover === null ? "no hover information returned." : hover.contents) };
    } catch (error) {
      return {
        ok: false,
        output:
          `lsp: ${server.name} could not answer (${error instanceof Error ? error.message : String(error)}). ` +
          `Install the server or point .weaver/lsp.json at one.`,
      };
    } finally {
      await client.close().catch(() => {});
    }
  },
};

export const lspTools: ToolDef[] = [lspTool];
