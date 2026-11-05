// Command-line parsing.
import { parseArgs } from "node:util";
import type { PermissionMode } from "../core/types.ts";
import { PRESETS } from "../providers/presets.ts";

/** First positional word that selects a subcommand instead of being a prompt. */
const COMMANDS = new Set(["setup", "providers", "models", "config", "auth", "sessions", "help", "version"]);

export interface CliArgs {
  prompt: string | null;
  command: string | null;
  commandArgs: string[];
  workspace: string | null;
  provider: string | null;
  model: string | null;
  permission: PermissionMode | null;
  canary: "auto" | "off" | null;
  script: string | null;
  resume: string | null;
  plain: boolean;
  tui: boolean;
  listSessions: boolean;
  help: boolean;
  version: boolean;
}

function asPermission(value: string | undefined): PermissionMode | null {
  return value === "auto" || value === "full" || value === "readonly" ? value : null;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      prompt: { type: "string", short: "p" },
      workspace: { type: "string", short: "C" },
      provider: { type: "string" },
      model: { type: "string", short: "m" },
      permission: { type: "string" },
      canary: { type: "string" },
      script: { type: "string" },
      resume: { type: "string" },
      plain: { type: "boolean" },
      tui: { type: "boolean" },
      "list-sessions": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });

  let command: string | null = null;
  let commandArgs: string[] = [];
  let promptPositionals = positionals;

  const first = positionals[0]?.toLowerCase();
  if (first !== undefined && COMMANDS.has(first)) {
    command = first === "version" ? null : first;
    commandArgs = positionals.slice(1);
    promptPositionals = [];
    if (first === "version") {
      return {
        prompt: null,
        command: null,
        commandArgs: [],
        workspace: values.workspace ?? null,
        provider: values.provider ?? null,
        model: values.model ?? null,
        permission: asPermission(values.permission),
        canary: values.canary === "off" ? "off" : values.canary === "auto" ? "auto" : null,
        script: values.script ?? null,
        resume: values.resume ?? null,
        plain: values.plain === true,
        tui: values.tui === true,
        listSessions: false,
        help: false,
        version: true,
      };
    }
  }

  const prompt = values.prompt ?? (promptPositionals.length > 0 ? promptPositionals.join(" ") : null);

  return {
    prompt: prompt === null || prompt.length === 0 ? null : prompt,
    command,
    commandArgs,
    workspace: values.workspace ?? null,
    provider: values.provider ?? null,
    model: values.model ?? null,
    permission: asPermission(values.permission),
    canary: values.canary === "off" ? "off" : values.canary === "auto" ? "auto" : null,
    script: values.script ?? null,
    resume: values.resume ?? null,
    plain: values.plain === true,
    tui: values.tui === true,
    listSessions: values["list-sessions"] === true,
    help: values.help === true,
    version: values.version === true,
  };
}

export const HELP = `
  [ weaver ] — the local-first coding agent that signs off on its own work
  a Zabibu Technika product · Weaver builds the nest, Canary guards the mine

  usage:
    weaver                       open the interactive terminal UI
    weaver -p "<task>"           run one task and exit
    weaver setup                 connect a provider (optional — it works without)
    weaver providers             list every endpoint and which keys are present
    weaver models                list the models the active provider offers

  options:
    -p, --prompt <text>          the task to run (otherwise interactive)
    -C, --workspace <dir>        where the agent may work (default: cwd)
        --provider <name>        ${PRESETS.map((preset) => preset.id).join(" | ")} | mock
    -m, --model <id>             model id for the provider (see: weaver models)
        --permission <mode>      auto (ask) | full (never ask) | readonly (never write)
        --canary <mode>          auto | off
        --script <file>          mock provider script (only with --provider mock)
        --resume <id>            resume a session id
        --list-sessions          list saved sessions
        --plain                  skip the TUI, use a plain line-based session
        --tui                    force the TUI even in a marginal terminal
    -h, --help                   show this help
    -v, --version                print the version

  running with no setup:
    Weaver needs no key to start. With nothing configured it picks a free,
    keyless endpoint, and if you already have GROQ_API_KEY (or GEMINI_API_KEY,
    OPENROUTER_API_KEY, OPENAI_API_KEY, TOGETHER_API_KEY) in your environment it
    finds that first. Run \`weaver providers\` to see the whole list.

  examples:
    weaver                       just start
    weaver setup                 connect Groq or Gemini for speed
    weaver -p "add a health endpoint to server.ts"
    npm run mock                 offline demo — no key, no network

  in the TUI:
    enter send · esc or ctrl+c cancel a running turn · ctrl+c twice exits
    ctrl+l clears · /help lists commands · ↑↓ history · pgup/pgdn scroll

  permission modes:
    auto      reads run freely; writes and shell commands ask first  (default)
    full      no prompts — trust the agent                             (careful)
    readonly  the agent may look but never change anything
`;
