// Non-interactive subcommands: `weaver providers|models|config|auth|sessions|checkpoints|undo`.
import { PRESETS, keyFor, modelsUrlFor, presetById, presetsInDisplayOrder } from "../providers/presets.ts";
import { configFilePath, writeConfigFile, type WeaverConfig } from "../config.ts";
import { engineLabel } from "../integrate/canary.ts";
import { listSessions } from "../core/session.ts";
import { list, stats, storeFor, type Store } from "../safety/checkpoints.ts";
import { apply, describe, describeResult, preview, previewLatest } from "../safety/undo.ts";
import {
  active as activeDecisions,
  ledgerFor,
  read as readDecisions,
  record as recordDecision,
  type DecisionKind,
} from "../../core/memory/decisions.ts";
import { detectChecks, runChecks, summarize as summarizeVerification } from "../../core/verification/index.ts";
import { activeAccount, detectIntegrations, switchAccount } from "../../core/integrations/index.ts";
import { lspTool } from "../../core/lsp/tool.ts";
import { callMcpTool, mcpStatus } from "../../core/mcp/index.ts";
import {
  listReceipts,
  receiptsDir,
  summarizeProof,
  writeReceipt,
} from "../../core/verification/receipt.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

// --- Checkpoints and undo -----------------------------------------------------
//
// The verbs a person needs after an agent has changed something: list what can be
// undone, see exactly what one would do, and do it. Nothing here runs during a session;
// this is the deliberate half.

function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function listCheckpoints(cfg: WeaverConfig, store: Store): Promise<number> {
  const entries = await list(store);
  console.log("");
  console.log(
    `  ${render.C.bold + render.C.amber}checkpoints${render.C.reset}${render.C.gray} — undo points in ${cfg.workspace}${render.C.reset}`,
  );
  console.log("");

  if (entries.length === 0) {
    console.log(render.C.gray + "  none yet — a checkpoint is taken automatically before any change." + render.C.reset);
    console.log("");
    return 0;
  }

  for (const [index, entry] of entries.entries()) {
    const mark = index === 0 ? `${render.C.amber}▸${render.C.reset}` : " ";
    const uncovered =
      entry.skipped.length > 0
        ? `${render.C.yellow} (${entry.skipped.length} not covered)${render.C.reset}`
        : "";
    console.log(
      `  ${mark} ${render.C.gray}${entry.id}${render.C.reset}  ${render.C.gray}${ago(entry.createdAt).padEnd(9)}${render.C.reset}` +
        `${entry.tool.padEnd(11)} ${entry.label}${uncovered}`,
    );
  }

  console.log("");
  console.log(render.C.gray + "  newest first · `weaver undo` restores the top one · `weaver checkpoints diff <id>` shows detail" + render.C.reset);
  console.log("");
  return 0;
}

async function diffCheckpoint(cfg: WeaverConfig, store: Store, id: string | undefined): Promise<number> {
  if (id === undefined) {
    render.error("usage: weaver checkpoints diff <id>");
    return 1;
  }
  const undo = await preview(store, cfg.workspace, id);
  if (undo === null) {
    render.error(`no checkpoint "${id}" — try \`weaver checkpoints\`.`);
    return 1;
  }
  const { headline, lines } = describe(undo);
  console.log("");
  console.log(`  ${render.C.bold}${headline}${render.C.reset}`);
  for (const line of lines) {
    const color =
      line.startsWith("delete") || line.startsWith("warning")
        ? render.C.yellow
        : line.startsWith("cannot")
          ? render.C.red
          : render.C.gray;
    console.log(`  ${color}${line}${render.C.reset}`);
  }
  console.log("");
  console.log(render.C.gray + "  nothing was changed — apply it with `weaver undo " + id + "`" + render.C.reset);
  console.log("");
  return 0;
}

async function showCheckpointStats(store: Store): Promise<number> {
  const snapshot = await stats(store);
  console.log("");
  for (const [key, value] of [
    ["checkpoints", String(snapshot.checkpoints)],
    ["saved copies", String(snapshot.blobs)],
    ["size", `${(snapshot.bytes / 1024).toFixed(0)} KB`],
    ["not covered", String(snapshot.skipped)],
  ] as const) {
    console.log(`  ${render.C.gray}${key.padEnd(14)}${render.C.reset}${value}`);
  }
  console.log("");
  return 0;
}

export async function showCheckpoints(
  cfg: WeaverConfig,
  sub: string | undefined,
  args: string[],
): Promise<number> {
  const store = storeFor(cfg.workspace);
  switch (sub) {
    case undefined:
    case "":
    case "list":
      return listCheckpoints(cfg, store);
    case "diff":
      return diffCheckpoint(cfg, store, args[0]);
    case "stats":
      return showCheckpointStats(store);
    default:
      render.error(`unknown checkpoints command "${sub}" — try list, diff <id>, restore <id>, stats`);
      return 1;
  }
}

export interface UndoOptions {
  /** Skip the confirmation. For scripts and for `--yes`. */
  yes: boolean;
  /** Ask the human. Only called when `yes` is false. */
  confirm: () => Promise<boolean>;
}

/**
 * Undo one checkpoint, or the newest one.
 *
 * Deliberately never automatic: restoring overwrites current files and can delete files
 * the call created. The preview exists so the confirmation is informed, and the preview
 * itself changes nothing.
 */
export async function undoCommand(
  cfg: WeaverConfig,
  target: string | null,
  options: UndoOptions,
): Promise<number> {
  const store = storeFor(cfg.workspace);
  const undo =
    target === null
      ? await previewLatest(store, cfg.workspace)
      : await preview(store, cfg.workspace, target);

  if (undo === null) {
    if (target === null) render.notice("nothing to undo — no checkpoints in this workspace.");
    else render.error(`no checkpoint "${target}" — try \`weaver checkpoints\`.`);
    return 1;
  }

  const { headline, lines } = describe(undo);
  console.log("");
  console.log(`  ${render.C.bold}${headline}${render.C.reset}`);
  for (const line of lines) {
    const color =
      line.startsWith("delete") || line.startsWith("warning")
        ? render.C.yellow
        : line.startsWith("cannot")
          ? render.C.red
          : render.C.gray;
    console.log(`  ${color}${line}${render.C.reset}`);
  }
  console.log("");

  if (undo.restore.length === 0 && undo.remove.length === 0) {
    render.notice("nothing would change — the checkpoint was not consumed.");
    return 0;
  }

  if (!options.yes && !(await options.confirm())) {
    render.notice("cancelled — nothing changed.");
    return 0;
  }

  const result = await apply(store, cfg.workspace, undo.id);
  if (result === null) {
    render.error("the checkpoint disappeared before it could be applied.");
    return 1;
  }

  for (const line of describeResult(result)) {
    if (line.startsWith("could not") || line.startsWith("the checkpoint was kept")) render.warn(line);
    else render.notice(line);
  }
  console.log("");
  return result.missing.length > 0 ? 1 : 0;
}

// --- Decisions and verification ----------------------------------------------
//
// Memory and proof, as two verbs. Both are read-mostly: the ledger is written by the
// agent during a turn, and verification is run by the agent after one. These commands
// exist so a human can inspect what the agent believes and what it proved.

const DECISION_KINDS: DecisionKind[] = ["choice", "rejection", "constraint", "assumption"];

export async function showDecisions(
  cfg: WeaverConfig,
  sub: string | undefined,
  args: string[],
): Promise<number> {
  const ledger = ledgerFor(cfg.workspace);

  if (sub === "add") {
    // `weaver decisions add <kind> <title> :: <rationale>`
    // `::` rather than `--`, because parseArgs consumes `--` as its own end-of-options
    // marker and it would never reach this function.
    const separator = args.indexOf("::");
    const head = separator === -1 ? args : args.slice(0, separator);
    const rationale = separator === -1 ? "" : args.slice(separator + 1).join(" ").trim();
    const kind = head[0] as DecisionKind | undefined;
    const title = head.slice(1).join(" ").trim();

    if (kind === undefined || !DECISION_KINDS.includes(kind) || title.length === 0 || rationale.length === 0) {
      render.error("usage: weaver decisions add <choice|rejection|constraint|assumption> <title> :: <why>");
      return 1;
    }

    const decision = await recordDecision(ledger, { kind, title, rationale, source: "user", tags: ["manual"] });
    render.notice(`recorded ${decision.id} — ${decision.title}`);
    return 0;
  }

  const { decisions, corrupt } = await readDecisions(ledger);
  const current = await activeDecisions(ledger);

  console.log("");
  console.log(
    `  ${render.C.bold + render.C.amber}decisions${render.C.reset}${render.C.gray} — what this project has already settled, in ${cfg.workspace}${render.C.reset}`,
  );
  console.log("");

  if (current.length === 0) {
    console.log(render.C.gray + "  none yet — the agent records a decision when Canary blocks a change." + render.C.reset);
    console.log(render.C.gray + "  add one with: weaver decisions add choice \"Use X\" :: \"because Y\"" + render.C.reset);
    console.log("");
    return 0;
  }

  for (const decision of [...current].reverse().slice(0, 20)) {
    const tag = decision.kind === "rejection" ? render.C.yellow : render.C.cyan;
    console.log(`  ${tag}[${decision.kind}]${render.C.reset} ${render.C.bold}${decision.title}${render.C.reset}`);
    console.log(render.C.gray + `      ${decision.rationale}` + render.C.reset);
    if (decision.constraints.length > 0) {
      console.log(render.C.gray + `      constraints: ${decision.constraints.join("; ")}` + render.C.reset);
    }
  }

  console.log("");
  console.log(
    render.C.gray +
      `  ${decisions.length} recorded · ${decisions.length - current.length} superseded` +
      (corrupt > 0 ? ` · ${corrupt} unreadable line(s)` : "") +
      render.C.reset,
  );
  console.log("");
  return 0;
}

export async function verifyCommand(cfg: WeaverConfig): Promise<number> {
  const checks = await detectChecks(cfg.workspace);
  if (checks.length === 0) {
    render.warn("no verification checks were detected in this workspace — there is nothing to prove with");
    render.notice("expected one of: package.json scripts, tsconfig + tsc, Cargo.toml, go.mod");
    return 1;
  }

  render.notice(`running ${checks.length} check(s) in ${cfg.workspace}`);
  const report = await runChecks(cfg.workspace, checks);
  console.log("");
  for (const line of summarizeVerification(report).split("\n")) {
    if (line.startsWith("PASS")) console.log(render.C.green + `  ${line}` + render.C.reset);
    else if (line.startsWith("SKIPPED")) console.log(render.C.yellow + `  ${line}` + render.C.reset);
    else if (line.startsWith("FAIL") || line.startsWith("TIMEOUT")) console.log(render.C.red + `  ${line}` + render.C.reset);
    else console.log(render.C.gray + `  ${line}` + render.C.reset);
  }
  console.log("");
  const written = await writeReceipt({ workspace: cfg.workspace, report, touched: [] });
  console.log(render.C.gray + `  proof: ${summarizeProof(written.receipt)}` + render.C.reset);
  console.log(render.C.gray + `  ${written.markdownPath}` + render.C.reset);
  console.log("");
  return report.ok ? 0 : 1;
}

// --- Receipts ----------------------------------------------------------------
//
// The durable half of "proved it". A receipt is a small artifact a human can read
// later, after the terminal has scrolled away and after the conversation has been
// compacted.

export async function showReceipts(
  cfg: WeaverConfig,
  sub: string | undefined,
  args: string[],
): Promise<number> {
  if (sub === "show") {
    const id = args[0];
    if (id === undefined) {
      render.error("usage: weaver receipts show <id>");
      return 1;
    }
    try {
      console.log(await readFile(join(receiptsDir(cfg.workspace), `${id}.md`), "utf8"));
      return 0;
    } catch {
      render.error(`no receipt "${id}" — try \`weaver receipts\``);
      return 1;
    }
  }

  const receipts = await listReceipts(cfg.workspace);
  console.log("");
  console.log(
    `  ${render.C.bold + render.C.amber}receipts${render.C.reset}${render.C.gray} — proof artifacts in ${cfg.workspace}${render.C.reset}`,
  );
  console.log("");

  if (receipts.length === 0) {
    console.log(render.C.gray + "  none yet — one is written after any turn that changes something." + render.C.reset);
    console.log("");
    return 0;
  }

  for (const receipt of receipts.slice(0, 20)) {
    const colour =
      receipt.status === "proved"
        ? render.C.green
        : receipt.status === "failed"
          ? render.C.red
          : render.C.yellow;
    const passed = receipt.checks.filter((check) => check.ok).length;
    const caveat = receipt.selfAuthored ? `${render.C.yellow} · self-authored${render.C.reset}` : "";
    console.log(
      `  ${colour}${receipt.status.padEnd(8)}${render.C.reset} ${render.C.gray}${receipt.at.slice(0, 16).replace("T", " ")}${render.C.reset}` +
        `  ${passed}/${receipt.checks.length} check(s)  ${receipt.id}${caveat}`,
    );
  }

  console.log("");
  console.log(render.C.gray + "  newest first · `weaver receipts show <id>` prints the artifact" + render.C.reset);
  console.log("");
  return 0;
}

// --- Integrations ------------------------------------------------------------
//
// The CLIs are the identity layer for what the agent produces. `weaver integrations`
// lists what is installed, which account is active, and which one this workspace chose;
// `use` switches both the CLI and the memory.

export async function showIntegrations(
  cfg: WeaverConfig,
  sub: string | undefined,
  args: string[],
): Promise<number> {
  const detected = await detectIntegrations(cfg.workspace, cfg.home);

  if (sub === "use") {
    const id = args[0];
    const wanted = args[1];
    if (id === undefined || wanted === undefined) {
      render.error("usage: weaver integrations use <id> <account>");
      return 1;
    }

    const entry = detected.find(
      (candidate) =>
        candidate.integration.id === id || candidate.integration.label.toLowerCase() === id.toLowerCase(),
    );
    if (entry === undefined) {
      render.error(`no integration "${id}" — try \`weaver integrations\``);
      return 1;
    }

    const account = entry.accounts.find(
      (candidate) => candidate.id === wanted || candidate.label === wanted,
    );
    if (account === undefined) {
      render.error(`no account "${wanted}" for ${entry.integration.label}`);
      return 1;
    }

    const result = await switchAccount(cfg.workspace, entry, account);
    if (result.ok) render.notice(result.message);
    else render.error(result.message);
    return result.ok ? 0 : 1;
  }

  console.log("");
  console.log(
    `  ${render.C.bold + render.C.amber}integrations${render.C.reset}${render.C.gray} — accounts this workspace can use${render.C.reset}`,
  );
  console.log("");

  if (detected.length === 0) {
    console.log(
      render.C.gray +
        "  none detected — install the GitHub CLI (gh) or Vercel (vercel), then sign in." +
        render.C.reset,
    );
    console.log("");
    return 0;
  }

  for (const entry of detected) {
    const active = activeAccount(entry);
    console.log(
      `  ${render.C.bold}${entry.integration.label}${render.C.reset} ${render.C.gray}(${entry.integration.binary}) · ${
        active?.label ?? "no active account"
      }${render.C.reset}`,
    );
    for (const account of entry.accounts) {
      const mark = account.active
        ? `${render.C.green}●${render.C.reset}`
        : entry.selected === account.id
          ? `${render.C.amber}○${render.C.reset}`
          : " ";
      const detail =
        account.detail === undefined
          ? ""
          : `${render.C.gray} · ${
              account.detail.length > 44 ? `${account.detail.slice(0, 43)}…` : account.detail
            }${render.C.reset}`;
      const id = account.id === account.label ? "" : `${render.C.gray} (${account.id})${render.C.reset}`;
      console.log(`    ${mark} ${account.label}${id}${detail}`);
    }
  }

  console.log("");
  console.log(render.C.gray + "  switch with: weaver integrations use <id> <account>" + render.C.reset);
  console.log("");
  return 0;
}

// --- LSP / MCP / subagent ------------------------------------------------

export async function lspCommand(cfg: WeaverConfig, args: string[]): Promise<number> {
  const [action, path, line, character] = args;
  if (action === undefined || path === undefined) {
    render.error("usage: weaver lsp <diagnostics|definition|references|hover> <file> [line] [character]");
    return 1;
  }
  const result = await lspTool.run(
    {
      action,
      path,
      line: line === undefined ? undefined : Number(line),
      character: character === undefined ? undefined : Number(character),
    },
    { workspace: cfg.workspace },
  );
  if (result.ok) console.log(result.output);
  else render.error(result.output);
  return result.ok ? 0 : 1;
}

export async function mcpCommand(cfg: WeaverConfig, args: string[]): Promise<number> {
  const sub = (args[0] ?? "list").toLowerCase();

  if (sub === "call") {
    const exposed = args[1];
    if (exposed === undefined) {
      render.error("usage: weaver mcp call <mcp__server__tool> '<json arguments>'");
      return 1;
    }
    const raw = args.slice(2).join(" ").trim();
    let input: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          render.error("mcp call: arguments must be a JSON object");
          return 1;
        }
        input = parsed as Record<string, unknown>;
      } catch {
        render.error("mcp call: arguments must be valid JSON");
        return 1;
      }
    }
    const result = await callMcpTool(cfg.workspace, exposed, input, cfg.home);
    if (result.ok) console.log(result.output);
    else render.error(result.output);
    return result.ok ? 0 : 1;
  }

  if (sub !== "list") {
    render.error("usage: weaver mcp list | weaver mcp call <mcp__server__tool> '<json>'");
    return 1;
  }

  const status = await mcpStatus(cfg.workspace, cfg.home);
  console.log("");
  if (status.length === 0) {
    console.log(render.C.gray + "  no MCP servers configured. Add .weaver/mcp.json with a servers map." + render.C.reset);
    console.log("");
    return 0;
  }
  for (const server of status) {
    if (server.error) {
      console.log(`  ${server.server}: unavailable - ${server.error}`);
      continue;
    }
    console.log(`  ${server.server}:`);
    for (const tool of server.tools) {
      console.log(`    ${tool.exposed}  ${tool.readOnly ? "read" : "writes"}`);
    }
  }
  console.log("");
  return 0;
}
