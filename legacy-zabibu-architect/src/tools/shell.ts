// Shell tool: run a command in the workspace, with a timeout and output cap.
import { spawn } from "node:child_process";
import type { ToolDef, ToolOutcome } from "../core/types.ts";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ShellResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  sandboxPrefix?: string | null,
): Promise<ShellResult> {
  const fullCommand = sandboxPrefix ? `${sandboxPrefix}${command}` : command;
  return new Promise((resolvePromise) => {
    const child = spawn(fullCommand, { cwd, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT * 4) child.kill();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT * 4) child.kill();
    });

    child.on("error", (err) => {
      finish({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

function clip(text: string, limit = MAX_OUTPUT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… output truncated` : text;
}

export const shellTool: ToolDef = {
  name: "run_shell",
  description: "Run a shell command in the workspace (builds, tests, git, package managers).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run." },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds. Defaults to 120000." },
    },
    required: ["command"],
  },
  mutating: true,
  // A shell command can read, destroy, and send, and no check can prove otherwise.
  // Declaring `unbounded` rather than inferring `local-write` from `mutating` is the
  // honest label, and it puts shell under the strictest trust rules. See SAFETY.md §5.
  capability: "unbounded",
  async run(input, ctx): Promise<ToolOutcome> {
    const command = typeof input.command === "string" ? input.command : null;
    if (command === null || command.trim().length === 0) {
      return { ok: false, output: "run_shell: `command` is required" };
    }

    const timeoutMs =
      typeof input.timeout_ms === "number" && input.timeout_ms > 0
        ? Math.floor(input.timeout_ms)
        : DEFAULT_TIMEOUT_MS;

    const result = await runShell(command, ctx.workspace, timeoutMs, ctx.sandboxPrefix);
    const parts: string[] = [`exit code: ${result.code ?? "killed"}`];
    if (result.timedOut) parts.push(`timed out after ${timeoutMs}ms`);
    if (result.stdout.trim().length > 0) parts.push(`stdout:\n${clip(result.stdout.trimEnd())}`);
    if (result.stderr.trim().length > 0) parts.push(`stderr:\n${clip(result.stderr.trimEnd())}`);
    if (result.stdout.trim().length === 0 && result.stderr.trim().length === 0) parts.push("(no output)");

    return { ok: result.code === 0 && !result.timedOut, output: parts.join("\n") };
  },
};
