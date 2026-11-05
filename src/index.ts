#!/usr/bin/env node
// Weaver — the local-first coding agent that signs off on its own work.
// Weaver builds the nest. Canary guards the mine. A Zabibu Technika product.
import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { HELP, parseCliArgs } from "./cli/args.ts";
import { isKeyMissing, loadConfig, WEAVER_ROOT, type WeaverConfig } from "./config.ts";
import { createProvider } from "./providers/index.ts";
import { allTools } from "./tools/index.ts";
import { newAgentState, runTurn } from "./core/agent.ts";
import { askConfirm, newSessionMeta, startRepl } from "./cli/repl.ts";
import { loadSession, newSessionId, saveSession } from "./core/session.ts";
import { canaryAvailable, engineLabel } from "./integrate/canary.ts";
import {
  listModels,
  listProviders,
  saveAuth,
  showCheckpoints,
  showConfig,
  showDecisions,
  showIntegrations,
  showReceipts,
  showSessions,
  undoCommand,
  verifyCommand,
} from "./cli/commands.ts";
import { runSetup } from "./setup.ts";
import { runTui, tuiSupported } from "./tui/index.ts";
import * as render from "./cli/render.ts";

/**
 * The version comes from package.json rather than a constant, because a constant drifts:
 * it said 0.2.0 while the package was 0.5.1. A number nobody remembers to update is a
 * number nobody can trust.
 */
function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(WEAVER_ROOT, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Undo needs a human, unless one was explicitly waived.
 *
 * Restoring overwrites current files and can delete files the call created, so a
 * non-interactive run without `--yes` refuses rather than guessing. That is the same
 * rule the tool gate uses: when consent cannot be obtained, the answer is no.
 */
async function undoWithConfirmation(
  config: WeaverConfig,
  target: string | null,
  yes: boolean,
): Promise<number> {
  if (!yes && stdin.isTTY !== true) {
    render.error("refusing to change files without confirmation — re-run with --yes");
    return 1;
  }
  const rl = !yes && stdin.isTTY === true ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    return await undoCommand(config, target, {
      yes,
      confirm: async () => {
        if (rl === null) return false;
        const answer = await rl.question("  apply this undo? [y/N] ");
        return /^y(es)?$/i.test(answer.trim());
      },
    });
  } finally {
    rl?.close();
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help || args.command === "help") {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(version());
    return;
  }

  const config = loadConfig({
    workspace: args.workspace ?? undefined,
    provider: args.provider ?? undefined,
    model: args.model ?? undefined,
    permission: args.permission ?? undefined,
    canary: args.canary ?? undefined,
    mockScript: args.script ?? undefined,
  });

  // Subcommands that never start a session.
  switch (args.command) {
    case "setup":
      process.exitCode = await runSetup(config);
      return;
    case "providers":
      listProviders(config);
      return;
    case "models":
      process.exitCode = await listModels(config);
      return;
    case "config":
      showConfig(config);
      return;
    case "auth":
      process.exitCode = saveAuth(config, args.commandArgs[0], args.commandArgs[1]);
      return;
    case "checkpoints": {
      const sub = args.commandArgs[0];
      if (sub === "restore") {
        process.exitCode = await undoWithConfirmation(config, args.commandArgs[1] ?? null, args.yes);
        return;
      }
      process.exitCode = await showCheckpoints(config, sub, args.commandArgs.slice(1));
      return;
    }
    case "undo":
      process.exitCode = await undoWithConfirmation(config, args.commandArgs[0] ?? null, args.yes);
      return;
    case "decisions":
      process.exitCode = await showDecisions(config, args.commandArgs[0], args.commandArgs.slice(1));
      return;
    case "verify":
      process.exitCode = await verifyCommand(config);
      return;
    case "receipts":
      process.exitCode = await showReceipts(config, args.commandArgs[0], args.commandArgs.slice(1));
      return;
    case "integrations":
      process.exitCode = await showIntegrations(config, args.commandArgs[0], args.commandArgs.slice(1));
      return;
    default:
      break;
  }

  if (args.command === "sessions" || args.listSessions) {
    showSessions(config.home);
    return;
  }

  if (isKeyMissing(config)) {
    render.error(`no API key for provider "${config.provider}".`);
    console.log(
      render.C.gray + `  ${config.preset?.keyEnv ?? "WEAVER_API_KEY"} is not set.` + render.C.reset,
    );
    console.log(
      render.C.gray + "  run `weaver setup` to connect a provider, drop --provider to use the" + render.C.reset,
    );
    console.log(
      render.C.gray + "  keyless free default (pollinations), or try the offline demo: npm run mock" + render.C.reset,
    );
    process.exitCode = 1;
    return;
  }

  const provider = createProvider(config);
  const state = newAgentState();
  let meta = newSessionMeta(config, newSessionId());

  if (args.resume !== null) {
    const stored = loadSession(config.home, args.resume);
    if (stored === null) {
      render.error(`no session "${args.resume}" — try --list-sessions`);
      process.exitCode = 1;
      return;
    }
    meta = stored.meta;
    state.messages.push(...stored.messages);
    render.notice(`resumed session ${meta.id} (${stored.messages.length} message(s))`);
  }

  const signOff = canaryAvailable(config)
    ? `canary: ${config.canary} · ${engineLabel(config)}`
    : "canary: unavailable (not a git repo)";

  if (args.prompt !== null) {
    // One-shot: ask for permission only if we have a terminal to ask on.
    const rl = stdin.isTTY === true ? createInterface({ input: stdin, output: stdout }) : null;
    const confirm = rl !== null ? askConfirm(rl) : async (): Promise<"no"> => "no";

    render.banner([
      `provider: ${config.provider} · model: ${config.model}`,
      `workspace: ${config.workspace}`,
      `permission: ${config.permission} · ${signOff}`,
    ]);

    render.assistantStart();
    await runTurn(
      { config, provider, tools: allTools, confirm, emit: render.renderEvent },
      state,
      args.prompt,
    );

    if (state.messages.length > 0) {
      meta.title = args.prompt.slice(0, 60);
      saveSession(config.home, { meta, messages: state.messages });
    }
    if (rl !== null) rl.close();
    return;
  }

  // Interactive. The TUI is the default whenever the terminal can host it.
  const useTui = args.tui || (!args.plain && tuiSupported());

  if (useTui) {
    if (!tuiSupported() && args.tui) {
      render.warn("this terminal is too small for the TUI — falling back to the plain session.");
    } else {
      await runTui({ config, provider, tools: allTools, state, meta });
      return;
    }
  }

  render.banner([
    `provider: ${config.provider} · model: ${config.model}`,
    `workspace: ${config.workspace}`,
    `permission: ${config.permission} · ${signOff}`,
    `sessions: ${config.home}`,
    `/help for commands · /exit to leave`,
  ]);

  await startRepl({ config, provider, tools: allTools, state, meta, emit: render.renderEvent });
}

await main();
