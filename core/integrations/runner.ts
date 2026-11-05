// Running an external CLI without a shell.
//
// `shell: false` is not a detail. These commands carry account names and repository names;
// passing that through a shell is how an account called `foo; rm -rf ~` becomes a command.
// Arguments are an array, and they stay an array all the way to spawn.
import { spawn } from "node:child_process";
import type { CommandRunner, RunResult } from "./types.ts";

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export const run: CommandRunner = (binary, args, options = {}) =>
  new Promise<RunResult>((resolvePromise) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    });

    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_OUTPUT ? current : current + chunk.toString("utf8").slice(0, MAX_OUTPUT - current.length);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        ms: Date.now() - started,
        timedOut,
      });
    };

    child.on("error", (error) => {
      stderr = append(stderr, Buffer.from(error.message));
      finish(null);
    });
    child.on("close", finish);
  });
