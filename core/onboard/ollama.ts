// Ollama, without a dependency.
//
// The onboarding flow needs three facts: is Ollama here, what is already pulled, and can we
// pull the recommended model. Each is a plain process call with a timeout, because a CLI
// that hangs must not hang the setup wizard.
import { spawn } from "node:child_process";

export interface PullResult {
  ok: boolean;
  message: string;
}

/** Parse `ollama list`; the first column is the model tag, the first line is the header. */
export function parseOllamaList(stdout: string): string[] {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) return [];

  return lines
    .slice(1)
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((name) => name.length > 0);
}

export function ollamaAvailable(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("ollama", ["--version"], { shell: false, windowsHide: true });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5_000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

export function installedModels(): Promise<string[]> {
  return new Promise((resolvePromise) => {
    const child = spawn("ollama", ["list"], { shell: false, windowsHide: true });
    let output = "";
    let settled = false;
    const finish = (value: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => finish(code === 0 ? parseOllamaList(output) : []));
  });
}

/**
 * Pull a model. This is a large download, so the caller must have asked first; the callback
 * streams progress so the user can see it is not stuck.
 */
export function pullModel(model: string, onLine?: (line: string) => void): Promise<PullResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("ollama", ["pull", model], { shell: false, windowsHide: true });
    let last = "";
    let settled = false;

    const finish = (result: PullResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: "the pull timed out" });
    }, 30 * 60 * 1000);

    const handle = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      last = text.trim().split("\n").filter((line) => line.length > 0).pop() ?? last;
      onLine?.(text);
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("error", (error) => finish({ ok: false, message: error.message }));
    child.on("close", (code) =>
      finish(
        code === 0
          ? { ok: true, message: `pulled ${model}` }
          : { ok: false, message: last.length > 0 ? last : `ollama exited ${code}` },
      ),
    );
  });
}
