// What this machine can actually run.
//
// Onboarding used to be "pick a provider and paste a key". That is the wrong first
// question for a local-first product: the machine decides which models are plausible, and
// the account's admin level decides how much the agent should be allowed to touch.
//
// This module is deliberately pure where it can be: the recommendation and the advice are
// functions of a profile, so they are testable without a device.
import { execFile } from "node:child_process";
import { mkdir, statfs } from "node:fs/promises";
import { arch, cpus, homedir, platform, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface DeviceProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpu: string;
  cores: number;
  ramGb: number;
  /** Free space on the base workspace's volume, or null when it cannot be read. */
  freeDiskGb: number | null;
  /** True for root/Administrator. Never used to grant access by itself. */
  admin: boolean;
  /** The default base all projects are written to unless `--workspace` says otherwise. */
  baseWorkspace: string;
}

/**
 * One directory, not one file.
 *
 * A coding agent needs several files; a "single file" base would make it useless. The
 * safety property the user actually wants is *confinement*: one known directory, outside
 * the system, that the agent defaults to. That is what this is.
 */
export function defaultBaseWorkspace(home: string = homedir()): string {
  return join(home, ".weaver", "workspace");
}

async function detectAdmin(): Promise<boolean> {
  if (process.platform !== "win32") {
    return typeof process.getuid === "function" && process.getuid() === 0;
  }
  try {
    const { stdout } = await exec("whoami", ["/groups"], { windowsHide: true, timeout: 5_000 });
    return stdout.includes("S-1-5-32-544");
  } catch {
    return false;
  }
}

export async function detectDevice(): Promise<DeviceProfile> {
  const base = defaultBaseWorkspace();
  let freeDiskGb: number | null = null;
  try {
    const stats = await statfs(base);
    freeDiskGb = Math.round((Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3);
  } catch {
    // The base may not exist yet; that is not an error.
  }

  const processors = cpus();
  return {
    platform: platform(),
    arch: arch(),
    cpu: processors[0]?.model?.trim() ?? "unknown",
    cores: processors.length,
    ramGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    freeDiskGb,
    admin: await detectAdmin(),
    baseWorkspace: base,
  };
}

export async function ensureBaseWorkspace(path: string = defaultBaseWorkspace()): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

export interface ModelRecommendation {
  /** Ollama tag. */
  id: string;
  label: string;
  params: string;
  /** Approximate download / memory footprint in GB. */
  approxGb: number;
  why: string;
}

const MODELS: Array<{ id: string; label: string; params: string; minRamGb: number; approxGb: number }> = [
  { id: "qwen2.5-coder:32b", label: "Qwen2.5 Coder 32B", params: "32B", minRamGb: 32, approxGb: 20 },
  { id: "qwen2.5-coder:14b", label: "Qwen2.5 Coder 14B", params: "14B", minRamGb: 16, approxGb: 10 },
  { id: "qwen2.5-coder:7b", label: "Qwen2.5 Coder 7B", params: "7B", minRamGb: 8, approxGb: 5 },
  { id: "qwen2.5-coder:1.5b", label: "Qwen2.5 Coder 1.5B", params: "1.5B", minRamGb: 0, approxGb: 2 },
];

/**
 * The largest model that fits, with room for the OS and the agent.
 *
 * RAM is the first filter; free disk is the second, because a model you cannot download is
 * not a recommendation. If both are unknown, the smallest model is the honest default.
 */
export function recommendModel(device: Pick<DeviceProfile, "ramGb" | "freeDiskGb">): ModelRecommendation {
  const byRam = MODELS.find((model) => device.ramGb >= model.minRamGb) ?? MODELS[MODELS.length - 1];
  const chosen =
    device.freeDiskGb === null
      ? byRam
      : MODELS.slice(MODELS.indexOf(byRam!)).find((model) => device.freeDiskGb! >= model.approxGb + 3) ?? byRam;

  const model = chosen ?? MODELS[MODELS.length - 1]!;
  return {
    id: model.id,
    label: model.label,
    params: model.params,
    approxGb: model.approxGb,
    why: `${device.ramGb} GB RAM${
      device.freeDiskGb === null ? "" : ` and ${device.freeDiskGb} GB free`
    } — this is the largest that fits with room for the OS`,
  };
}

/**
 * Advice, not policy. The agent still asks before writes and shell; being an administrator
 * does not turn that off, and `full` is never chosen here.
 */
export function permissionAdvice(device: Pick<DeviceProfile, "admin" | "freeDiskGb">): string[] {
  const lines: string[] = [];
  if (device.admin) {
    lines.push(
      "You are an administrator/root. Weaver will still ask before writing and running commands; it never defaults to full access.",
    );
  } else {
    lines.push(
      "You are a standard user. Writes are confined to the base workspace, and shell commands still ask first.",
    );
  }
  if (device.freeDiskGb !== null && device.freeDiskGb < 10) {
    lines.push("Free disk is low; a smaller model is the safer choice.");
  }
  return lines;
}
