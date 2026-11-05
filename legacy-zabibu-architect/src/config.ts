// Configuration: env + .env + ~/.weaver/config.json + CLI overrides.
//
// The important property here is that Weaver runs with *no* configuration at
// all. If no provider is named and no key is anywhere to be found, it selects a
// keyless free endpoint rather than refusing to start.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "./core/types.ts";
import { PRESETS, endpointFor, presetById, type ProviderPreset } from "./providers/presets.ts";
import { PROFILES, profileById, type Profile, type ProfileId } from "./onboard/profiles.ts";

/** The weaver package root (the directory containing package.json). */
export const WEAVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where Weaver keeps sessions and anything else it must remember. */
export const WEAVER_HOME = join(homedir(), ".weaver");

/** How the provider was chosen — surfaced so the UI can explain itself. */
export type ProviderSource = "flag" | "env" | "config" | "detected" | "default";

export interface WeaverConfig {
  workspace: string;
  weaverRoot: string;
  home: string;
  provider: string;
  providerSource: ProviderSource;
  /** The registry entry behind `provider`, or null for a hand-rolled endpoint. */
  preset: ProviderPreset | null;
  model: string;
  apiKey: string;
  /** The full chat-completions URL, or null when nothing usable is configured. */
  endpoint: string | null;
  nativeTools: boolean;
  permission: PermissionMode;
  maxSteps: number;
  temperature: number;
  canary: "auto" | "off";
  /**
   * Who is using this, and how much ceremony they want. Set by onboarding and stored in
   * ~/.weaver/config.json. It adjusts friction, exposure, and verbosity — never the trust
   * boundaries, which are invariants and not preferences. See onboard/profiles.ts.
   */
  profile: Profile;
  /**
   * How many times the agent may repair a change and have it re-judged after the
   * sign-off BLOCKs. 0 turns the repair loop off and restores the older behaviour
   * of stopping at the first verdict. Capped, because an unbounded retry loop is
   * a way to spend money without learning anything.
   */
  canaryRepair: number;
  /** An explicit engine override, for development. The default is the vendored copy. */
  canaryEngine: string | null;
  mockScript: string | null;
}

export interface ConfigOverrides {
  workspace?: string;
  provider?: string;
  model?: string;
  permission?: PermissionMode;
  canary?: "auto" | "off";
  profile?: ProfileId;
  mockScript?: string;
  baseUrl?: string;
}

/** What lives in ~/.weaver/config.json. */
export interface WeaverConfigFile {
  provider?: string;
  model?: string;
  apiKey?: string;
  permission?: PermissionMode;
  canary?: "auto" | "off";
  profile?: ProfileId;
  workspace?: string;
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** Load .env from each directory, without clobbering anything already set. */
export function loadDotEnv(...dirs: string[]): void {
  for (const dir of dirs) {
    const file = join(dir, ".env");
    if (!existsSync(file)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseDotEnv(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/** WEAVER_HOME, or the default ~/.weaver. */
export function resolveHome(): string {
  const override = process.env.WEAVER_HOME;
  return override !== undefined && override.length > 0 ? resolve(override) : WEAVER_HOME;
}

export function configFilePath(home: string): string {
  return join(home, "config.json");
}

export function readConfigFile(home: string): WeaverConfigFile {
  const file = configFilePath(home);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as WeaverConfigFile;
  } catch {
    return {};
  }
}

/** Merge a patch into ~/.weaver/config.json and return the path written. */
export function writeConfigFile(home: string, patch: WeaverConfigFile): string {
  const file = configFilePath(home);
  const merged: WeaverConfigFile = { ...readConfigFile(home), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Store the profile chosen in onboarding.
 *
 * Separate from `loadConfig` because the act of choosing is a human decision that
 * deserves to be explicit and confirmable, not a side effect of reading a file.
 */
export function saveProfile(home: string, id: ProfileId): string {
  return writeConfigFile(home, { profile: id });
}

/** The first provider in the registry whose key is already in the environment. */
export function detectProvider(): string | null {
  for (const preset of PRESETS) {
    if (preset.keyEnv === null) continue;
    const value = process.env[preset.keyEnv];
    if (value !== undefined && value.length > 0) return preset.id;
  }
  return null;
}

/**
 * A permission mode, falling back to the profile's rather than to a hard-coded "auto".
 *
 * The profile is the right default because it is what onboarding established and the
 * user agreed to. Anything that names a mode explicitly still wins — a flag is a newer
 * decision than a stored preference.
 */
function asPermission(value: string | undefined, fallback: PermissionMode): PermissionMode {
  return value === "full" || value === "readonly" || value === "auto" ? value : fallback;
}

/**
 * The engine is vendored into `src/engine/`, so there is nothing to detect: the
 * default is always the pinned copy. This only honours an explicit override, used
 * to A/B the embedded engine against a working tree during Canary development.
 */
function detectCanaryEngine(explicit: string | undefined): string | null {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  return null;
}

/** True when the chosen provider needs a key and does not have one. */
export function isKeyMissing(cfg: WeaverConfig): boolean {
  if (cfg.provider === "mock") return false;
  if (cfg.preset === null) return cfg.endpoint === null && cfg.apiKey.length === 0;
  if (cfg.preset.keyEnv === null) return false;
  return cfg.apiKey.length === 0;
}

export function loadConfig(overrides: ConfigOverrides = {}): WeaverConfig {
  const home = resolveHome();
  const file = readConfigFile(home);
  // Who is using this. An unknown id is not an error — it falls back to `general`,
  // because a typo in a config file must not stop the tool from starting.
  const profile = profileById(overrides.profile ?? process.env.WEAVER_PROFILE ?? file.profile);
  const workspace = resolve(
    overrides.workspace ?? process.env.WEAVER_WORKSPACE ?? file.workspace ?? process.cwd(),
  );

  // .env wins nothing over a real environment variable, but it is read first.
  loadDotEnv(workspace, WEAVER_ROOT, home);

  // Precedence: flag > env > config file > a key we found lying around > keyless default.
  let provider: string;
  let providerSource: ProviderSource;
  const envProvider = process.env.WEAVER_PROVIDER;

  if (overrides.provider !== undefined && overrides.provider.length > 0) {
    provider = overrides.provider.toLowerCase();
    providerSource = "flag";
  } else if (envProvider !== undefined && envProvider.length > 0) {
    provider = envProvider.toLowerCase();
    providerSource = "env";
  } else if (file.provider !== undefined && file.provider.length > 0) {
    provider = file.provider.toLowerCase();
    providerSource = "config";
  } else {
    const detected = detectProvider();
    if (detected !== null) {
      provider = detected;
      providerSource = "detected";
    } else {
      provider = "pollinations";
      providerSource = "default";
    }
  }

  const preset = presetById(provider);

  let apiKey = "";
  if (provider === "mock") {
    apiKey = "mock";
  } else if (preset !== null && preset.keyEnv !== null) {
    const fromEnv = process.env[preset.keyEnv];
    if (fromEnv !== undefined && fromEnv.length > 0) apiKey = fromEnv;
  }

  // A key saved by `weaver setup`/`weaver auth`, only for the provider it names.
  if (apiKey.length === 0 && file.apiKey !== undefined && file.apiKey.length > 0) {
    const fileProvider = (file.provider ?? provider).toLowerCase();
    if (fileProvider === provider) apiKey = file.apiKey;
  }

  if (apiKey.length === 0) {
    const universal = process.env.WEAVER_API_KEY;
    if (universal !== undefined && universal.length > 0) apiKey = universal;
  }

  const endpoint =
    overrides.baseUrl ?? process.env.WEAVER_BASE_URL ?? (preset !== null ? endpointFor(preset) : null);

  const fileModel =
    file.provider !== undefined && file.provider.toLowerCase() === provider ? file.model : undefined;

  const model =
    overrides.model ??
    process.env.WEAVER_MODEL ??
    fileModel ??
    preset?.defaultModel ??
    (provider === "mock" ? "mock" : "");

  const maxSteps = Number.parseInt(process.env.WEAVER_MAX_STEPS ?? "24", 10);
  const canaryRepair = Number.parseInt(process.env.WEAVER_CANARY_REPAIR ?? "1", 10);

  return {
    workspace,
    weaverRoot: WEAVER_ROOT,
    home,
    provider,
    providerSource,
    preset,
    model,
    apiKey,
    endpoint,
    nativeTools: preset?.nativeTools ?? true,
    permission: overrides.permission ?? asPermission(process.env.WEAVER_PERMISSION ?? file.permission, profile.permission),
    maxSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : 24,
    temperature: 0.2,
    profile,
    canary: overrides.canary ?? (process.env.WEAVER_CANARY === "off" ? "off" : file.canary === "off" ? "off" : "auto"),
    canaryRepair: Number.isFinite(canaryRepair) ? Math.min(Math.max(canaryRepair, 0), 5) : profile.repairPasses,
    canaryEngine: detectCanaryEngine(process.env.WEAVER_CANARY_ENGINE),
    mockScript: overrides.mockScript ?? process.env.WEAVER_MOCK_SCRIPT ?? null,
  };
}
