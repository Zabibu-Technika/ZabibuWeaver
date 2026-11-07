// Turn configured MCP servers into ordinary Weaver tools.
//
// The tool names are namespaced, the input schema is passed through, and the capability is
// deliberately conservative: a tool is read-only only when the server says so. Everything
// else is `unbounded`, which means the permission gate asks before it runs.
import type { Capability, ToolDef } from "../contracts/tool.ts";
import { McpClient, mcpContentText, type McpCallResult, type McpTool } from "./client.ts";
import { loadMcpServers } from "./config.ts";

export interface McpStatusEntry {
  server: string;
  tools: Array<{ name: string; exposed: string; readOnly: boolean }>;
  error?: string;
}

function sanitize(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 48);
  return cleaned.length > 0 ? cleaned : "tool";
}

function clip(text: string, limit = 8000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… [truncated]`;
}

interface Entry {
  server: string;
  client: McpClient;
  tool: McpTool;
  exposed: string;
  capability: Capability;
}

export class McpManager {
  private clients: McpClient[] = [];
  private entries: Entry[] = [];
  private statusEntries: McpStatusEntry[] = [];
  private closed = false;

  async load(workspace: string, home?: string): Promise<void> {
    const servers = await loadMcpServers(workspace, home);
    const used = new Set<string>();

    for (const server of servers) {
      const client = new McpClient(server.name, server.config, workspace);
      try {
        await client.initialize();
        const tools = await client.listTools();
        this.clients.push(client);
        const status: McpStatusEntry = { server: server.name, tools: [] };

        for (const tool of tools) {
          const readOnly = tool.annotations?.readOnlyHint === true;
          const capability: Capability = readOnly ? "read" : "unbounded";
          let exposed = `mcp__${sanitize(server.name)}__${sanitize(tool.name)}`;
          let suffix = 2;
          while (used.has(exposed)) {
            exposed = `mcp__${sanitize(server.name)}__${sanitize(tool.name)}_${suffix}`;
            suffix += 1;
          }
          used.add(exposed);
          this.entries.push({ server: server.name, client, tool, exposed, capability });
          status.tools.push({ name: tool.name, exposed, readOnly });
        }
        this.statusEntries.push(status);
      } catch (error) {
        await client.close().catch(() => {});
        this.statusEntries.push({
          server: server.name,
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  tools(): ToolDef[] {
    return this.entries.map((entry) => this.asTool(entry));
  }

  status(): McpStatusEntry[] {
    return this.statusEntries;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) {
      await client.close().catch(() => {});
    }
    this.clients = [];
    this.entries = [];
  }

  private asTool(entry: Entry): ToolDef {
    const description = entry.tool.description ?? entry.tool.name;
    return {
      name: entry.exposed,
      description: `[mcp:${entry.server}] ${description}`,
      parameters:
        entry.tool.inputSchema && typeof entry.tool.inputSchema === "object"
          ? entry.tool.inputSchema
          : { type: "object", properties: {} },
      mutating: entry.capability !== "read",
      capability: entry.capability,
      ingest: "external",
      async run(input): Promise<{ ok: boolean; output: string }> {
        try {
          const result = (await entry.client.callTool(entry.tool.name, input)) as McpCallResult;
          return { ok: result.isError !== true, output: clip(mcpContentText(result)) };
        } catch (error) {
          return {
            ok: false,
            output: `mcp:${entry.server}:${entry.tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    };
  }
}

let active: McpManager | null = null;

/** Start configured servers and return their tools. No configuration means no tools. */
export async function loadMcpTools(workspace: string, home?: string): Promise<ToolDef[]> {
  if (active !== null) await active.close();
  const manager = new McpManager();
  await manager.load(workspace, home);
  active = manager;
  return manager.tools();
}

/** A one-shot status read for the CLI. */
export async function mcpStatus(workspace: string, home?: string): Promise<McpStatusEntry[]> {
  const manager = new McpManager();
  await manager.load(workspace, home);
  const status = manager.status();
  await manager.close();
  return status;
}

export async function closeMcp(): Promise<void> {
  if (active !== null) {
    await active.close();
    active = null;
  }
}

/** One-shot call for the CLI. The exposed name is the `mcp__server__tool` name. */
export async function callMcpTool(
  workspace: string,
  exposed: string,
  input: Record<string, unknown>,
  home?: string,
): Promise<{ ok: boolean; output: string }> {
  const manager = new McpManager();
  await manager.load(workspace, home);
  try {
    const tool = manager.tools().find((candidate) => candidate.name === exposed);
    if (tool === undefined) {
      return { ok: false, output: `no MCP tool "${exposed}" — run \`mcp list\` for the exposed names.` };
    }
    return await tool.run(input, { workspace });
  } finally {
    await manager.close();
  }
}
