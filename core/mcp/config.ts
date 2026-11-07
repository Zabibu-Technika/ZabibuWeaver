// MCP configuration. Nothing is started unless the user names a server here.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfigFile {
  servers?: Record<string, McpServerConfig>;
}

export interface ConfiguredServer {
  name: string;
  config: McpServerConfig;
  source: string;
}

function valid(config: McpServerConfig | undefined): config is McpServerConfig {
  return config !== undefined && typeof config.command === "string" && config.command.trim().length > 0;
}

async function readConfig(path: string): Promise<{ servers: Record<string, McpServerConfig>; source: string }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as McpConfigFile;
    const servers = parsed.servers ?? {};
    const clean: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(servers)) {
      if (valid(config)) clean[name] = config;
    }
    return { servers: clean, source: path };
  } catch {
    return { servers: {}, source: path };
  }
}

export async function loadMcpServers(workspace: string, home = homedir()): Promise<ConfiguredServer[]> {
  const user = await readConfig(join(home, ".weaver", "mcp.json"));
  const project = await readConfig(join(workspace, ".weaver", "mcp.json"));

  const merged = new Map<string, ConfiguredServer>();
  for (const [name, config] of Object.entries(user.servers)) {
    merged.set(name, { name, config, source: user.source });
  }
  for (const [name, config] of Object.entries(project.servers)) {
    merged.set(name, { name, config, source: project.source });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
