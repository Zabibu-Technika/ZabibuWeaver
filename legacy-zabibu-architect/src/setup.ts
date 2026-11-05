// First-run setup: pick an endpoint, paste a key, done.
//
// This is deliberately *not* required. Weaver starts and works with no setup at
// all. This wizard exists for people who want a faster or more reliable free
// provider than the keyless default.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { presetsInDisplayOrder } from "./providers/presets.ts";
import { configFilePath, detectProvider, writeConfigFile, type WeaverConfig } from "./config.ts";
import * as render from "./cli/render.ts";

export async function runSetup(cfg: WeaverConfig): Promise<number> {
  const options = presetsInDisplayOrder();

  // `rl.question` never settles on a pipe, so refuse politely instead of hanging.
  if (stdin.isTTY !== true) {
    render.error("`weaver setup` needs an interactive terminal.");
    console.log(
      render.C.gray +
        "  non-interactively, use `weaver auth <provider> <key>`, or set the key's" +
        render.C.reset,
    );
    console.log(
      render.C.gray +
        "  environment variable. `weaver providers` lists both for every endpoint." +
        render.C.reset,
    );
    return 1;
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log("");
    console.log(
      `  ${render.C.bold + render.C.amber}weaver setup${render.C.reset} ${render.C.gray}— connect a provider${render.C.reset}`,
    );
    console.log("");
    console.log(render.C.gray + "  Weaver already runs with no setup: its default is Pollinations," + render.C.reset);
    console.log(render.C.gray + "  which needs no account and no key. Everything below is faster and" + render.C.reset);
    console.log(render.C.gray + "  more reliable, and every free option has a free tier." + render.C.reset);
    console.log("");

    for (let i = 0; i < options.length; i += 1) {
      const preset = options[i];
      if (preset === undefined) continue;
      const tier = preset.free
        ? `${render.C.green}free${render.C.reset}`
        : `${render.C.gray}paid${render.C.reset}`;
      const needs = preset.keyEnv === null ? "no key" : preset.keyEnv;
      console.log(
        `  ${render.C.bold}${String(i + 1).padStart(2)}${render.C.reset}  ${preset.label.padEnd(16)}${tier}  ${render.C.gray}${needs}${render.C.reset}`,
      );
      console.log(render.C.gray + `      ${preset.note}` + render.C.reset);
      if (preset.signup !== null) console.log(render.C.gray + `      ${preset.signup}` + render.C.reset);
    }

    console.log("");
    const detected = detectProvider();
    if (detected !== null) {
      console.log(
        render.C.gray + `  heads up: a key for "${detected}" is already in your environment.` + render.C.reset,
      );
    }

    const picked = (await rl.question(`  ${render.C.cyan}choose a number${render.C.reset} ${render.C.gray}(or Enter to cancel)${render.C.reset} `)).trim();
    if (picked.length === 0) {
      render.notice("nothing changed.");
      return 0;
    }

    const index = Number.parseInt(picked, 10) - 1;
    const preset = options[index];
    if (preset === undefined) {
      render.error(`"${picked}" is not one of the listed numbers.`);
      return 1;
    }

    if (preset.keyEnv === null) {
      const file = writeConfigFile(cfg.home, { provider: preset.id, apiKey: undefined });
      console.log("");
      render.notice(`${preset.label} needs no key. Saved to ${file}.`);
      if (preset.id === "ollama") {
        console.log(
          render.C.gray +
            `  make sure Ollama is running and the model is pulled: ollama pull ${preset.defaultModel}` +
            render.C.reset,
        );
      }
      return 0;
    }

    console.log("");
    console.log(render.C.gray + `  ${preset.label} needs a key.` + render.C.reset);
    if (preset.signup !== null) {
      console.log(render.C.gray + `  get one here: ${preset.signup}` + render.C.reset);
    }

    const key = (
      await rl.question(`  ${render.C.cyan}paste the key${render.C.reset} ${render.C.gray}(or Enter to cancel)${render.C.reset} `)
    ).trim();

    if (key.length === 0) {
      render.notice("nothing changed.");
      return 0;
    }

    const file = writeConfigFile(cfg.home, { provider: preset.id, apiKey: key });
    console.log("");
    render.notice(`connected ${preset.label}. Saved to ${file}.`);
    console.log(
      render.C.gray +
        "  the key is stored in plain text, readable by your user account. Setting" +
        render.C.reset,
    );
    console.log(
      render.C.gray +
        `  ${preset.keyEnv} in your environment overrides it whenever you want.` +
        render.C.reset,
    );
    console.log("");
    console.log(
      render.C.gray +
        `  next: weaver --provider ${preset.id}${preset.defaultModel.length > 0 ? ` --model ${preset.defaultModel}` : ""}` +
        render.C.reset,
    );
    return 0;
  } catch {
    render.notice("setup cancelled.");
    return 0;
  } finally {
    rl.close();
  }
}

/** Printed after a successful setup, and by `weaver config`. */
export function describeSource(cfg: WeaverConfig): string {
  switch (cfg.providerSource) {
    case "flag":
      return "--provider";
    case "env":
      return "WEAVER_PROVIDER";
    case "config":
      return configFilePath(cfg.home);
    case "detected":
      return "an API key in your environment";
    default:
      return "the keyless default";
  }
}
