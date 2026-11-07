// A small LSP client over stdio.
//
// This is deliberately not a full editor integration. It answers the questions a coding
// agent actually needs before changing code: what does the language server report, where is
// this symbol defined, who references it, and what does the type say. The model asks; the
// server answers; no model-authored command is executed.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface LspServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  extensions: string[];
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspHover {
  contents: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const SEVERITY: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

function languageIdFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    default:
      return "plaintext";
  }
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner;
  }
  return JSON.stringify(value);
}

function locationText(location: LspLocation): string {
  const file = decodeURIComponent(location.uri.replace(/^file:\/\//, ""));
  return `${file}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
}

export class LspClient {
  private readonly config: LspServerConfig;
  private readonly root: string;
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  private diagnosticWaiters = new Map<string, Array<() => void>>();
  private closed = false;
  private spawnError: Error | null = null;

  constructor(config: LspServerConfig, root: string) {
    this.config = config;
    this.root = root;
    this.child = spawn(config.command, config.args ?? [], {
      cwd: root,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.on("error", (error) => {
      this.spawnError = error;
      this.failAll(error);
    });
    this.child.on("exit", () => {
      if (!this.closed) this.failAll(new Error("language server exited"));
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // Drain stderr so a chatty server cannot block on a full pipe.
    this.child.stderr.on("data", () => {});
  }

  async initialize(): Promise<void> {
    if (this.spawnError) throw this.spawnError;
    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "weaver", version: "0.8.0" },
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "workspace" }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
          publishDiagnostics: {},
          definition: {},
          references: {},
          hover: {},
        },
      },
    });
    this.notify("initialized", {});
  }

  async open(path: string): Promise<string> {
    const absolute = isAbsolute(path) ? path : resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("path is outside the workspace");
    }
    const text = await readFile(absolute, "utf8");
    const uri = pathToFileURL(absolute).href;
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageIdFor(absolute), version: 1, text },
    });
    return uri;
  }

  async diagnostics(uri: string, timeoutMs = 3000): Promise<LspDiagnostic[]> {
    const current = this.diagnosticsByUri.get(uri);
    if (current !== undefined) return current;

    await new Promise<void>((resolvePromise) => {
      const waiters = this.diagnosticWaiters.get(uri) ?? [];
      waiters.push(resolvePromise);
      this.diagnosticWaiters.set(uri, waiters);

      const timer = setTimeout(() => {
        const pending = this.diagnosticWaiters.get(uri) ?? [];
        this.diagnosticWaiters.set(uri, pending.filter((entry) => entry !== resolvePromise));
        resolvePromise();
      }, timeoutMs);
      timer.unref?.();
    });

    return this.diagnosticsByUri.get(uri) ?? [];
  }

  async definition(uri: string, position: LspPosition): Promise<LspLocation[]> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri },
      position,
    });
    return this.asLocations(result);
  }

  async references(uri: string, position: LspPosition): Promise<LspLocation[]> {
    const result = await this.request("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return this.asLocations(result);
  }

  async hover(uri: string, position: LspPosition): Promise<LspHover | null> {
    const result = await this.request("textDocument/hover", {
      textDocument: { uri },
      position,
    });
    if (!result || typeof result !== "object") return null;
    const contents = (result as { contents?: unknown }).contents;
    if (contents === undefined) return null;
    return { contents: asText(contents) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("shutdown", null, 1000);
    } catch {
      // A server that is already gone is fine.
    }
    try {
      this.notify("exit", null);
    } catch {
      // The pipe may already be closed.
    }
    this.closed = true;
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
    } else {
      this.child.kill();
    }
  }

  private asLocations(value: unknown): LspLocation[] {
    if (Array.isArray(value)) {
      return value.filter((entry): entry is LspLocation => Boolean(entry && typeof entry === "object" && "uri" in entry));
    }
    if (value && typeof value === "object" && "uri" in value) return [value as LspLocation];
    return [];
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.handle(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // A malformed frame is the server's problem; keep reading.
      }
    }
  }

  private handle(message: Record<string, unknown>): void {
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] } | undefined;
      if (params?.uri) {
        this.diagnosticsByUri.set(params.uri, params.diagnostics ?? []);
        for (const waiter of this.diagnosticWaiters.get(params.uri) ?? []) waiter();
        this.diagnosticWaiters.delete(params.uri);
      }
      return;
    }

    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(asText(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated requests. A coding agent does not need to answer most of them; a
    // null result keeps the server from waiting forever.
    if (message.id !== undefined && message.method) {
      this.notifyResponse(message.id as number | string, null);
    }
  }

  private notifyResponse(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`language server timed out on ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.write(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(payload: unknown): void {
    if (this.closed) return;
    const body = JSON.stringify(payload);
    const bytes = Buffer.byteLength(body, "utf8");
    this.child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function formatDiagnostics(path: string, diagnostics: LspDiagnostic[]): string {
  if (diagnostics.length === 0) return `${path}: no diagnostics published by the language server.`;
  return diagnostics
    .map((diagnostic) => {
      const severity = SEVERITY[diagnostic.severity ?? 1] ?? "diagnostic";
      const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
      return `${path}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${severity}${source}: ${diagnostic.message}`;
    })
    .join("\n");
}

export function formatLocations(locations: LspLocation[]): string {
  if (locations.length === 0) return "no locations returned.";
  return locations.map(locationText).join("\n");
}
