// A small MCP client over stdio.
//
// MCP servers are user-configured programs. The client starts only what the user wrote in
// .weaver/mcp.json, and every tool call still goes through Weaver's permission contract.
// Results are marked `external`: an MCP server can return text written by anyone.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface McpContent {
  type: string;
  text?: string;
}

export interface McpCallResult {
  content?: McpContent[];
  isError?: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  readonly name: string;
  private child: ChildProcessWithoutNullStreams;
  private lines: Interface;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private spawnError: Error | null = null;

  constructor(name: string, config: McpServerConfig, cwd: string) {
    this.name = name;
    this.child = spawn(config.command, config.args ?? [], {
      cwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.on("error", (error) => {
      this.spawnError = error;
      this.failAll(error);
    });
    this.child.on("exit", () => {
      if (!this.closed) this.failAll(new Error(`MCP server ${this.name} exited`));
    });
    this.child.stderr.on("data", () => {});
    process.once("exit", () => {
      try {
        this.child.kill();
      } catch {
        // Already gone.
      }
    });
  }

  async initialize(): Promise<void> {
    if (this.spawnError) throw this.spawnError;
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "weaver", version: "0.8.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args })) as McpCallResult;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    try {
      this.child.stdin.end();
    } catch {
      // Already closed.
    }
    if (this.child.exitCode === null) {
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(resolvePromise, 500);
        timer.unref?.();
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
        this.child.kill();
      });
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  private request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`MCP server ${this.name} timed out on ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(payload: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function mcpContentText(result: McpCallResult): string {
  const parts = (result.content ?? [])
    .map((entry) => {
      if (entry.type === "text") return entry.text ?? "";
      return `[${entry.type}]`;
    })
    .filter((entry) => entry.length > 0);
  return parts.join("\n") || (result.isError ? "MCP tool returned an error with no text." : "MCP tool returned no text content.");
}
