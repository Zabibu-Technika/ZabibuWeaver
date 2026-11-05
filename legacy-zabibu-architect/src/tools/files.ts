// Filesystem tools: read, write, edit, list, glob, grep.
//
// Every path is resolved and checked against the workspace root, so the agent
// cannot wander out of the project it was pointed at.
//
// WHY READING A FILE MARKS ITS CONTENT UNTRUSTED
//
// Each read tool below declares `ingest: "external"`. That looks like overkill — the
// file is on the user's own machine — and it is the most consequential label in this
// file, so the reasoning belongs where someone will find it before changing it.
//
// A path is a location, not a trust level. Cloning a repository hands you an attacker's
// filesystem; `npm install` hands you a stranger's. A README, a dependency's changelog,
// a CI log line, or even a *filename* can carry text written to manipulate whoever or
// whatever reads it. When the reader is an agent that can run commands, that text is an
// instruction channel, and it is a more reliable one than a webpage because nobody
// thinks to distrust their own disk.
//
// Labelling all of this `local` meant `hasExternal()` never fired on it, so the trust
// layer in `trust/taint.ts` was effectively a web-only control. An external review found
// it, and it was a real hole: read a poisoned README, run a curl, and nothing asked.
//
// The cost is bounded, not zero, and `taint.ts` is where it is paid. If every file read
// tainted the turn, every edit after every read would prompt, and consent that fires
// constantly is consent nobody reads. So the gate is narrower than "anything was read":
// exfiltration paths are gated on context, shell is judged by reading the command
// itself, and the ordinary edit is left alone.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolDef, ToolOutcome } from "../core/types.ts";

const MAX_READ_LINES = 2000;
const MAX_WALK_ENTRIES = 6000;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".weaver", ".next", "dist", "build", "out",
  "__pycache__", ".venv", "venv", ".ruff_cache", ".turbo", "coverage",
]);

export function resolveInWorkspace(workspace: string, path: string): string {
  const root = resolve(workspace);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${path}`);
  }
  return target;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function asString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function errorOutput(tool: string, err: unknown): ToolOutcome {
  return { ok: false, output: `${tool}: ${err instanceof Error ? err.message : String(err)}` };
}

/** Translate a glob into a regex. Supports **, * and ? over posix-style paths. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

async function walk(
  root: string,
  onFile: (abs: string, rel: string) => Promise<boolean> | boolean,
): Promise<void> {
  const queue: string[] = [root];
  let visited = 0;

  while (queue.length > 0) {
    const dir = queue.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_WALK_ENTRIES) return;

      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(abs);
      } else if (entry.isFile()) {
        const keepGoing = await onFile(abs, toPosix(relative(root, abs)));
        if (keepGoing === false) return;
      }
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export const readFileTool: ToolDef = {
  name: "read_file",
  description: "Read a UTF-8 text file from the workspace, optionally a line range.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      start: { type: "integer", description: "First line to return (1-based)." },
      end: { type: "integer", description: "Last line to return (inclusive)." },
    },
    required: ["path"],
  },
  mutating: false,
  // Declared, not inferred. `mutating: false` says the tool changes nothing; it says
  // nothing about whether it SENDS something, and inference would quietly call a
  // network-fetching tool a harmless read. Every tool in the registry states its class.
  capability: "read",
  ingest: "external",
  async run(input, ctx): Promise<ToolOutcome> {
    const path = asString(input, "path");
    if (path === null) return { ok: false, output: "read_file: `path` is required" };

    try {
      const abs = resolveInWorkspace(ctx.workspace, path);
      const text = await readFile(abs, "utf8");
      const lines = text.split("\n");
      const total = lines.length;

      const start = typeof input.start === "number" ? Math.max(1, Math.floor(input.start)) : 1;
      const end =
        typeof input.end === "number"
          ? Math.min(total, Math.floor(input.end))
          : Math.min(total, start + MAX_READ_LINES - 1);

      const slice = lines.slice(start - 1, end).join("\n");
      const header = `${path} (lines ${start}-${end} of ${total})`;
      const note = end < total ? `\n… ${total - end} more line(s); re-read with start=${end + 1}.` : "";
      return { ok: true, output: `${header}\n${slice}${note}` };
    } catch (err) {
      return errorOutput("read_file", err);
    }
  },
};

export const writeFileTool: ToolDef = {
  name: "write_file",
  description: "Create or overwrite a file with new content. Parent directories are created.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
  },
  mutating: true,
  capability: "local-write",
  async run(input, ctx): Promise<ToolOutcome> {
    const path = asString(input, "path");
    const content = asString(input, "content");
    if (path === null || content === null) {
      return { ok: false, output: "write_file: `path` and `content` are required" };
    }

    try {
      const abs = resolveInWorkspace(ctx.workspace, path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return { ok: true, output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}` };
    } catch (err) {
      return errorOutput("write_file", err);
    }
  },
};

export const editFileTool: ToolDef = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. Fails unless oldString is unique, unless replaceAll is set.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      oldString: { type: "string", description: "Exact text to find. Include surrounding context to be unique." },
      newString: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
    },
    required: ["path", "oldString", "newString"],
  },
  mutating: true,
  capability: "local-write",
  async run(input, ctx): Promise<ToolOutcome> {
    const path = asString(input, "path");
    const oldString = asString(input, "oldString");
    const newString = asString(input, "newString");
    if (path === null || oldString === null || newString === null) {
      return { ok: false, output: "edit_file: `path`, `oldString` and `newString` are required" };
    }
    if (oldString.length === 0) return { ok: false, output: "edit_file: `oldString` must not be empty" };

    try {
      const abs = resolveInWorkspace(ctx.workspace, path);
      const text = await readFile(abs, "utf8");
      const count = countOccurrences(text, oldString);

      if (count === 0) return { ok: false, output: `edit_file: no match for oldString in ${path}` };

      const replaceAll = input.replaceAll === true;
      if (count > 1 && !replaceAll) {
        return {
          ok: false,
          output: `edit_file: oldString matches ${count} times in ${path} — add context or set replaceAll`,
        };
      }

      const at = text.indexOf(oldString);
      const next = replaceAll
        ? text.split(oldString).join(newString)
        : text.slice(0, at) + newString + text.slice(at + oldString.length);

      await writeFile(abs, next, "utf8");
      return { ok: true, output: `replaced ${replaceAll ? count : 1} occurrence(s) in ${path}` };
    } catch (err) {
      return errorOutput("edit_file", err);
    }
  },
};

export const listDirTool: ToolDef = {
  name: "list_dir",
  description: "List the entries of a directory in the workspace.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path; defaults to the workspace root." } },
  },
  mutating: false,
  // Declared, not inferred. `mutating: false` says the tool changes nothing; it says
  // nothing about whether it SENDS something, and inference would quietly call a
  // network-fetching tool a harmless read. Every tool in the registry states its class.
  capability: "read",
  ingest: "external",
  async run(input, ctx): Promise<ToolOutcome> {
    const path = asString(input, "path") ?? ".";
    try {
      const abs = resolveInWorkspace(ctx.workspace, path);
      const entries = await readdir(abs, { withFileTypes: true });
      const listing = entries
        .filter((entry) => !SKIP_DIRS.has(entry.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort();
      return { ok: true, output: listing.length > 0 ? listing.join("\n") : `${path} is empty` };
    } catch (err) {
      return errorOutput("list_dir", err);
    }
  },
};

export const globTool: ToolDef = {
  name: "glob_files",
  description: "Find files by glob pattern, e.g. `src/**/*.ts`.",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string", description: "Glob pattern relative to the workspace root." } },
    required: ["pattern"],
  },
  mutating: false,
  // Declared, not inferred. `mutating: false` says the tool changes nothing; it says
  // nothing about whether it SENDS something, and inference would quietly call a
  // network-fetching tool a harmless read. Every tool in the registry states its class.
  capability: "read",
  ingest: "external",
  async run(input, ctx): Promise<ToolOutcome> {
    const pattern = asString(input, "pattern");
    if (pattern === null) return { ok: false, output: "glob_files: `pattern` is required" };

    const matcher = globToRegExp(pattern);
    const matches: string[] = [];
    await walk(ctx.workspace, (_abs, rel) => {
      if (matcher.test(rel)) matches.push(rel);
      return matches.length < MAX_GLOB_RESULTS;
    });

    matches.sort();
    return {
      ok: true,
      output: matches.length > 0 ? matches.join("\n") : `no files match ${pattern}`,
    };
  },
};

export const grepTool: ToolDef = {
  name: "grep",
  description: "Search file contents with a JavaScript regular expression.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      include: { type: "string", description: "Optional glob limiting which files are searched." },
    },
    required: ["pattern"],
  },
  mutating: false,
  // Declared, not inferred. `mutating: false` says the tool changes nothing; it says
  // nothing about whether it SENDS something, and inference would quietly call a
  // network-fetching tool a harmless read. Every tool in the registry states its class.
  capability: "read",
  ingest: "external",
  async run(input, ctx): Promise<ToolOutcome> {
    const pattern = asString(input, "pattern");
    if (pattern === null) return { ok: false, output: "grep: `pattern` is required" };

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return { ok: false, output: `grep: invalid pattern — ${err instanceof Error ? err.message : String(err)}` };
    }

    const include = asString(input, "include");
    const includeMatcher = include === null ? null : globToRegExp(include);
    const hits: string[] = [];

    await walk(ctx.workspace, async (abs, rel) => {
      if (includeMatcher !== null && !includeMatcher.test(rel)) return true;

      let text: string;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        return true;
      }
      if (text.includes("\u0000")) return true; // looks binary

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (regex.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= MAX_GREP_MATCHES) return false;
        }
      }
      return true;
    });

    return { ok: true, output: hits.length > 0 ? hits.join("\n") : `no matches for ${pattern}` };
  },
};

export const fileTools: ToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
];
