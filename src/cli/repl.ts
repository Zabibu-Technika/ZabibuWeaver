// Interactive session: a readline loop over the agent.
import { createInterface } from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Confirm, ConfirmAnswer } from "../core/types.ts";
import type { AgentEvent, AgentState } from "../core/agent.ts";
import { runTurn } from "../core/agent.ts";
import type { WeaverConfig } from "../config.ts";
import type { Provider } from "../core/types.ts";
import type { ToolDef } from "../core/types.ts";
import { listSessions, saveSession, type SessionMeta } from "../core/session.ts";
import { list as listCheckpoints, storeFor } from "../safety/checkpoints.ts";
import { apply, describe, describeResult, preview, previewLatest } from "../safety/undo.ts";
import * as render from "./render.ts";

/** A checkpoint previewed by /undo, waiting for /undo yes. */
let pendingUndo: string | null = null;

export interface SessionDeps {
  config: WeaverConfig;
  provider: Provider;
  tools: ToolDef[];
  state: AgentState;
  meta: SessionMeta;
  emit: (event: AgentEvent) => void;
}

/** Ask a yes/no/always question on an existing readline interface. */
export function askConfirm(rl: Interface): Confirm {
  return async (question: string): Promise<ConfirmAnswer> => {
    if (stdin.isTTY !== true) return "no";
    const answer = (await rl.question(`  ${render.C.yellow}allow${render.C.reset} ${question} ${render.C.gray}[y/N/a]${render.C.reset} `))
      .trim()
      .toLowerCase();
    if (answer === "a" || answer === "always") return "always";
    if (answer === "y" || answer === "yes") return "yes";
    return "no";
  };
}

export function newSessionMeta(cfg: WeaverConfig, id: string): SessionMeta {
  return {
    id,
    createdAt: new Date().toISOString(),
    title: "untitled",
    provider: cfg.provider,
    model: cfg.model,
    workspace: cfg.workspace,
  };
}

function persist(deps: SessionDeps): void {
  // Never write an empty session — exiting without a turn should leave no trace.
  if (deps.state.messages.length === 0) return;
  saveSession(deps.config.home, { meta: deps.meta, messages: deps.state.messages });
}

function printSessions(cfg: WeaverConfig): void {
  const sessions = listSessions(cfg.home);
  if (sessions.length === 0) {
    console.log(render.C.gray + "no saved sessions yet." + render.C.reset);
    return;
  }
  for (const session of sessions) {
    console.log(`${render.C.cyan}${session.id}${render.C.reset}  ${session.title}  ${render.C.gray}(${session.model})${render.C.reset}`);
  }
}

async function handleCommand(deps: SessionDeps, input: string): Promise<boolean> {
  const [command, ...rest] = input.slice(1).split(/\s+/);
  const value = rest.join(" ").trim();

  switch (command) {
    case "help":
    case "h":
      console.log(render.C.gray + [
        "  /help                 this list",
        "  /tools                tools the agent can use",
        "  /provider             which endpoint is in use",
        "  /sessions             saved sessions",
        "  /permission <mode>    auto | full | readonly",
        "  /canary <mode>        auto | off",
        "  /session              current session id",
        "  /checkpoints          what can be undone",
        "  /undo [id|yes]        preview, then apply an undo",
        "  /exit                 leave",
      ].join("\n") + render.C.reset);
      return true;

    case "tools":
      for (const tool of deps.tools) {
        const tag = tool.mutating ? render.C.yellow + "writes" + render.C.reset : render.C.gray + "read" + render.C.reset;
        console.log(`  ${tool.name.padEnd(12)} ${tag}  ${render.C.gray}${tool.description}${render.C.reset}`);
      }
      return true;

    case "sessions":
      printSessions(deps.config);
      return true;

    case "provider":
      console.log(render.C.gray + `  provider: ${deps.config.provider} (${deps.config.providerSource}) · model: ${deps.config.model}` + render.C.reset);
      console.log(render.C.gray + `  endpoint: ${deps.config.endpoint ?? "—"}` + render.C.reset);
      console.log(render.C.gray + "  change it with `weaver setup`, then restart." + render.C.reset);
      return true;

    case "session":
      console.log(render.C.gray + `  session ${deps.meta.id} · ${deps.state.messages.length} message(s)` + render.C.reset);
      return true;

    case "permission":
      if (value === "auto" || value === "full" || value === "readonly") {
        deps.config.permission = value;
        console.log(render.C.gray + `  permission mode: ${value}` + render.C.reset);
      } else {
        render.warn("usage: /permission auto|full|readonly");
      }
      return true;

    case "canary":
      if (value === "auto" || value === "off") {
        deps.config.canary = value;
        console.log(render.C.gray + `  canary sign-off: ${value}` + render.C.reset);
      } else {
        render.warn("usage: /canary auto|off");
      }
      return true;

    case "checkpoints": {
      const entries = await listCheckpoints(storeFor(deps.config.workspace));
      if (entries.length === 0) {
        console.log(render.C.gray + "  no checkpoints yet — one is taken before any change." + render.C.reset);
        return true;
      }
      for (const entry of entries.slice(0, 20)) {
        const uncovered =
          entry.skipped.length > 0 ? `${render.C.yellow} (${entry.skipped.length} not covered)${render.C.reset}` : "";
        console.log(
          `  ${render.C.gray}${entry.id}${render.C.reset}  ${entry.tool.padEnd(11)} ${entry.label}${uncovered}`,
        );
      }
      return true;
    }

    case "undo": {
      const store = storeFor(deps.config.workspace);

      if (value === "cancel") {
        pendingUndo = null;
        render.notice("undo cancelled — nothing changed.");
        return true;
      }

      if (value === "yes") {
        if (pendingUndo === null) {
          render.warn("nothing staged — run /undo first");
          return true;
        }
        const id = pendingUndo;
        pendingUndo = null;
        const result = await apply(store, deps.config.workspace, id);
        if (result === null) {
          render.warn("that checkpoint was already applied");
          return true;
        }
        for (const line of describeResult(result)) {
          if (line.startsWith("could not") || line.startsWith("the checkpoint was kept")) render.warn(line);
          else render.notice(line);
        }
        return true;
      }

      const undo =
        value.length > 0
          ? await preview(store, deps.config.workspace, value)
          : await previewLatest(store, deps.config.workspace);

      if (undo === null) {
        if (value.length > 0) render.error(`no checkpoint "${value}"`);
        else render.notice("nothing to undo — no checkpoints yet");
        return true;
      }

      const { headline, lines } = describe(undo);
      console.log("");
      console.log(`  ${render.C.bold}${headline}${render.C.reset}`);
      for (const line of lines) {
        const color =
          line.startsWith("delete") || line.startsWith("warning") || line.startsWith("cannot")
            ? render.C.yellow
            : render.C.gray;
        console.log(`  ${color}${line}${render.C.reset}`);
      }
      pendingUndo = undo.id;
      console.log(render.C.gray + "  /undo yes to apply · /undo cancel to leave it" + render.C.reset);
      return true;
    }

    case "exit":
    case "quit":
      return false;

    default:
      render.warn(`unknown command /${command} — try /help`);
      return true;
  }
}

export async function startRepl(deps: SessionDeps): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = askConfirm(rl);

  // If stdin ends (a pipe, or a closed terminal) readline never settles a
  // pending question. Race it so the process can still exit cleanly.
  let ended = false;
  const finished = new Promise<null>((resolve) => {
    rl.on("close", () => {
      ended = true;
      resolve(null);
    });
  });

  for (;;) {
    let line: string;
    try {
      const answer = await Promise.race([rl.question(render.promptLine()), finished]);
      if (answer === null) break;
      line = answer;
    } catch {
      break;
    }
    if (ended) break;

    const input = line.trim();
    if (input.length === 0) continue;

    if (input === "exit" || input === "quit") break;

    if (input.startsWith("/")) {
      if (!(await handleCommand(deps, input))) break;
      continue;
    }

    if (deps.meta.title === "untitled") deps.meta.title = input.slice(0, 60);

    render.assistantStart();
    await runTurn(
      { config: deps.config, provider: deps.provider, tools: deps.tools, confirm, emit: deps.emit },
      deps.state,
      input,
    );
    persist(deps);
  }

  persist(deps);
  rl.close();
}
