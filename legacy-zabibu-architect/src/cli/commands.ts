// Non-interactive subcommands: `weaver providers|models|config|auth|sessions`.
import { PRESETS, keyFor, modelsUrlFor, presetById, presetsInDisplayOrder } from "../providers/presets.ts";
import { configFilePath, writeConfigFile, type WeaverConfig } from "../config.ts";
import { engineLabel } from "../integrate/canary.ts";
import { listSessions } from "../core/session.ts";
import * as render from "./render.ts";

export function listProviders(cfg: WeaverConfig): void {
  console.log("");
  console.log(
    `  ${render.C.bold + render.C.amber}weaver providers${render.C.reset}${render.C.gray} — every endpoint Weaver can talk to${render.C.reset}`,
  );
  console.log("");

  for (const preset of presetsInDisplayOrder()) {
    const active = preset.id === cfg.provider;
    const mark = active ? `${render.C.amber}▸${render.C.reset}` : " ";
    const tier = preset.free
      ? `${render.C.green}free${render.C.reset}`
      : `${render.C.gray}paid${render.C.reset}`;

    let key: string;
    if (preset.keyEnv === null) key = `${render.C.gray}no key needed${render.C.reset}`;
    else if (keyFor(preset) !== null) key = `${render.C.green}${preset.keyEnv} set${render.C.reset}`;
    else key = `${render.C.yellow}${preset.keyEnv} missing${render.C.reset}`;

    console.log(`  ${mark} ${render.C.bold}${preset.id.padEnd(13)}${render.C.reset}${tier}  ${key}`);
    console.log(render.C.gray + `      ${preset.note}` + render.C.reset);
    if (preset.signup !== null) console.log(render.C.gray + `      ${preset.signup}` + render.C.reset);
  }

  console.log("");
  console.log(
    render.C.gray +
      `  active: ${cfg.provider} (${cfg.providerSource}) · model: ${cfg.model}` +
      render.C.reset,
  );
  console.log(
    render.C.gray +
      "  connect one with `weaver setup`, or set WEAVER_PROVIDER / WEAVER_MODEL" +
      render.C.reset,
  );
  console.log("");
}

function modelsEndpoint(cfg: WeaverConfig): string | null {
  if (cfg.preset !== null) return modelsUrlFor(cfg.preset);
  if (cfg.endpoint === null) return null;
  return cfg.endpoint.replace(/\/chat\/completions\/?$/, "/models");
}

/** Endpoints disagree about the shape of a model listing. Accept all of them. */
function extractModelIds(json: unknown): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) out.push(value);
  };
  const fromEntry = (entry: unknown): void => {
    if (typeof entry === "string") {
      push(entry);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    const record = entry as { id?: unknown; name?: unknown; model?: unknown };
    push(record.id ?? record.name ?? record.model);
  };

  if (Array.isArray(json)) {
    for (const entry of json) fromEntry(entry);
  } else if (json !== null && typeof json === "object") {
    const data = (json as { data?: unknown; models?: unknown }).data;
    if (Array.isArray(data)) for (const entry of data) fromEntry(entry);
  }

  return [...new Set(out)].sort();
}

export async function listModels(cfg: WeaverConfig): Promise<number> {
  const url = modelsEndpoint(cfg);
  if (url === null) {
    render.error("no endpoint to query — pick a provider or set WEAVER_BASE_URL");
    return 1;
  }

  const headers: Record<string, string> = {};
  if (cfg.apiKey.length > 0) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let json: unknown;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      render.error(`HTTP ${res.status} from ${url}`);
      return 1;
    }
    json = (await res.json()) as unknown;
  } catch (err) {
    render.error(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const ids = extractModelIds(json);
  if (ids.length === 0) {
    render.warn(`no models listed at ${url}`);
    return 1;
  }

  console.log("");
  console.log(render.C.gray + `  ${ids.length} model(s) available from ${cfg.provider}` + render.C.reset);
  for (const id of ids.slice(0, 80)) console.log(`  ${id}`);
  if (ids.length > 80) console.log(render.C.gray + `  … ${ids.length - 80} more` + render.C.reset);
  console.log("");
  console.log(render.C.gray + "  use one with --model <id> or WEAVER_MODEL=<id>" + render.C.reset);
  console.log("");
  return 0;
}

export function showConfig(cfg: WeaverConfig): void {
  const keyState =
    cfg.apiKey.length > 0
      ? `set (${cfg.apiKey.length} chars)`
      : cfg.preset !== null && cfg.preset.keyEnv === null
        ? "not needed"
        : "missing";

  const rows: Array<[string, string]> = [
    ["provider", `${cfg.provider} (${cfg.providerSource})`],
    ["model", cfg.model],
    ["endpoint", cfg.endpoint ?? "—"],
    ["api key", keyState],
    ["tools", cfg.nativeTools ? "native tool calls" : "prompted tool protocol"],
    ["workspace", cfg.workspace],
    ["permission", cfg.permission],
    ["max steps", String(cfg.maxSteps)],
    ["canary", cfg.canary],
    ["canary engine", engineLabel(cfg)],
    ["home", cfg.home],
    ["config file", configFilePath(cfg.home)],
  ];

  console.log("");
  for (const [key, value] of rows) {
    console.log(`  ${render.C.gray}${key.padEnd(14)}${render.C.reset}${value}`);
  }
  console.log("");
}

export function saveAuth(cfg: WeaverConfig, provider: string | undefined, key: string | undefined): number {
  if (provider === undefined || provider.length === 0) {
    render.error("usage: weaver auth <provider> <key>");
    console.log(render.C.gray + `  providers: ${PRESETS.map((p) => p.id).join(", ")}` + render.C.reset);
    return 1;
  }

  const preset = presetById(provider.toLowerCase());
  if (preset === null) {
    render.error(`unknown provider "${provider}"`);
    console.log(render.C.gray + `  providers: ${PRESETS.map((p) => p.id).join(", ")}` + render.C.reset);
    return 1;
  }

  if (preset.keyEnv === null) {
    const file = writeConfigFile(cfg.home, { provider: preset.id, apiKey: undefined });
    render.notice(`${preset.id} needs no key — saved the provider choice to ${file}`);
    return 0;
  }

  const value = key ?? "";
  if (value.length === 0) {
    render.error(`no key given — usage: weaver auth ${preset.id} <key>`);
    if (preset.signup !== null) {
      console.log(render.C.gray + `  get one at ${preset.signup}` + render.C.reset);
    }
    return 1;
  }

  const file = writeConfigFile(cfg.home, { provider: preset.id, apiKey: value });
  render.notice(`saved the ${preset.id} key to ${file}`);
  console.log(
    render.C.gray +
      "  note: it is stored in plain text, readable by your user account. A real" +
      render.C.reset,
  );
  console.log(
    render.C.gray +
      `  environment variable (${preset.keyEnv}) takes precedence if you set one.` +
      render.C.reset,
  );
  return 0;
}

export function showSessions(home: string): void {
  const sessions = listSessions(home);
  if (sessions.length === 0) {
    console.log(render.C.gray + "no saved sessions." + render.C.reset);
    return;
  }
  for (const session of sessions) {
    console.log(
      `${render.C.cyan}${session.id}${render.C.reset}  ${session.title}  ${render.C.gray}(${session.model})${render.C.reset}`,
    );
  }
}
