// The terminal UI.
//
// Hand-rolled on ANSI: an alternate screen, raw-mode input, a scrolling
// transcript, a live streaming pane, an inline permission prompt, and a status
// bar. No dependencies — which is why it also cannot corrupt a package tree.
//
// The layout itself lives in ./frame.ts, which is pure and therefore testable.
// This file is the state machine and the terminal plumbing around it.
//
// Everything here degrades: if the window is too small, or stdin is not a
// terminal, the caller falls back to the plain REPL. The fancy path is never the
// only path.
import { stdin, stdout } from "node:process";
import * as A from "./ansi.ts";
import { ESCAPE_TIMEOUT_MS, KeyParser, type Key } from "./keys.ts";
import {
  composeFrame,
  encodeFrame,
  firstLines,
  MIN_COLS,
  MIN_ROWS,
  severityStyle,
  SPINNER,
  summarizeArgs,
  toLines,
  type FrameLine,
  type Style,
} from "./frame.ts";
import type { AgentEvent, AgentState } from "../core/agent.ts";
import { runTurn } from "../core/agent.ts";
import type { Confirm, ConfirmAnswer, Provider, ToolDef } from "../core/types.ts";
import type { WeaverConfig } from "../config.ts";
import { listSessions, saveSession, type SessionMeta } from "../core/session.ts";
import type { CanaryReport } from "../integrate/canary.ts";
import { reportOrigin } from "../integrate/canary.ts";

export interface TuiDeps {
  config: WeaverConfig;
  provider: Provider;
  tools: ToolDef[];
  state: AgentState;
  meta: SessionMeta;
}

const TICK_MS = 50;

/** True when the fancy path can actually run here. */
export function tuiSupported(): boolean {
  return (
    stdin.isTTY === true &&
    stdout.isTTY === true &&
    (stdout.columns ?? 0) >= MIN_COLS &&
    (stdout.rows ?? 0) >= MIN_ROWS
  );
}

export async function runTui(deps: TuiDeps): Promise<void> {
  const { config, provider, tools, state, meta } = deps;

  let transcript: FrameLine[] = [];
  let streaming = "";
  let busy = false;
  let statusText = "";
  let spinnerIndex = 0;
  let turnStart = Date.now();
  let input = "";
  let cursor = 0;
  let scroll = 0;
  let dirty = true;
  let cleaned = false;
  let exiting = false;
  let history: string[] = [];
  let historyIndex = -1;
  let queued: string | null = null;
  let pending: { question: string; resolve: (answer: ConfirmAnswer) => void } | null = null;
  let abort: AbortController | null = null;
  let lastInterrupt = 0;
  let lastCols = stdout.columns ?? 80;
  let lastRows = stdout.rows ?? 24;
  // The first paint, and every resize, must clear the screen first: a stale
  // frame can be taller or wider than this one.
  let fullRepaint = true;

  let timer: ReturnType<typeof setInterval> | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void = () => {};

  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const parser = new KeyParser();

  // ---------------------------------------------------------------- transcript

  function push(text: string, style: Style): void {
    transcript.push({ text, style });
    dirty = true;
  }

  function pushAll(lines: FrameLine[]): void {
    transcript.push(...lines);
    dirty = true;
  }

  function pushCanary(report: CanaryReport): void {
    const origin = reportOrigin(report);
    pushAll([
      { text: "", style: "dim" },
      { text: `[ canary ] ${origin}`, style: "canary" },
    ]);

    if (report.judgeError !== undefined) {
      push("SIGN-OFF FAILED — this change was never judged, so it is BLOCKED.", "fail");
      push(report.judgeError, "warn");
      push("an unjudged change is not a clean one. fix the judge and re-run.", "dim");
      return;
    }

    push(
      `risk ${report.riskScore}/100 · grade ${report.grade} · ${report.verdict} ` +
        `(${report.filesChanged} file(s), +${report.insertions} / -${report.deletions})`,
      "dim",
    );

    for (const finding of report.findings) {
      push(`[${finding.severity}] ${finding.title}`, severityStyle(finding.severity));
      if (finding.filePath !== undefined) push(`  file: ${finding.filePath}`, "dim");
    }

    if (report.findings.length === 0) push("no findings — the change looks safe.", "ok");

    if (report.approved) push("signed off in the approval ledger.", "ok");
    else if (report.blocked) {
      push("BLOCKED — critical findings without a signed approval.", "fail");
      // Deliberately no bypass offered: Weaver embeds the judge, not the pen.
      push("weaver cannot sign this itself. clear the findings and re-run, or have a", "dim");
      push("human sign the receipt in canary (`zabibucanary review`).", "dim");
    }

    if (report.untracked.length > 0) {
      const names = report.untracked.slice(0, 5).join(", ");
      const more = report.untracked.length > 5 ? ` +${report.untracked.length - 5} more` : "";
      push(`${report.untracked.length} untracked file(s) not covered: ${names}${more}`, "warn");
      push("git diff cannot see new files — stage them to bring them into the sign-off.", "dim");
    }
  }

  function welcome(): void {
    push("weaver — the local-first coding agent that signs off on its own work.", "heading");
    push("Weaver builds the nest. Canary guards the mine.", "dim");
    push("", "dim");

    const preset = config.preset;
    const keyNote =
      preset !== null && preset.keyEnv === null
        ? " (no key needed)"
        : config.apiKey.length > 0
          ? " (key found)"
          : "";

    push(`provider: ${config.provider}${keyNote} · model: ${config.model}`, "dim");
    push(`workspace: ${config.workspace}`, "dim");
    push(`permission: ${config.permission} · canary: ${config.canary}`, "dim");
    push("", "dim");

    if (config.providerSource === "default") {
      push("connected to a free keyless endpoint, so this works with no setup.", "notice");
      push("run `weaver setup` to connect Groq or Gemini — both faster and free.", "notice");
      push("", "dim");
    } else if (config.providerSource === "detected") {
      push(`picked up an existing key for ${config.provider} from your environment.`, "notice");
      push("", "dim");
    }

    push("ask for a change, or type /help.", "notice");
  }

  // ------------------------------------------------------------------ commands

  function command(text: string): "ok" | "exit" {
    const parts = text.slice(1).trim().split(/\s+/);
    const name = (parts[0] ?? "").toLowerCase();
    const value = parts.slice(1).join(" ").trim();

    switch (name) {
      case "exit":
      case "quit":
        return "exit";

      case "clear":
        transcript = [];
        streaming = "";
        scroll = 0;
        dirty = true;
        return "ok";

      case "help":
        pushAll([
          { text: "commands", style: "heading" },
          { text: "/help                 this list", style: "dim" },
          { text: "/tools                tools the agent can use", style: "dim" },
          { text: "/permission <mode>    auto | full | readonly", style: "dim" },
          { text: "/canary <mode>        auto | off", style: "dim" },
          { text: "/provider             which endpoint is in use", style: "dim" },
          { text: "/session              current session id", style: "dim" },
          { text: "/sessions             saved sessions", style: "dim" },
          { text: "/clear                wipe the transcript", style: "dim" },
          { text: "/exit                 leave", style: "dim" },
          { text: "", style: "dim" },
          { text: "keys", style: "heading" },
          { text: "enter send · esc / ctrl+c cancel a turn · ctrl+c twice exits", style: "dim" },
          { text: "ctrl+l clear · ctrl+u kill line · ↑↓ history · pgup/pgdn scroll", style: "dim" },
        ]);
        return "ok";

      case "tools":
        for (const tool of tools) {
          push(
            `${tool.name.padEnd(12)} ${tool.mutating ? "writes" : "read"}  ${tool.description}`,
            tool.mutating ? "warn" : "dim",
          );
        }
        return "ok";

      case "permission":
        if (value === "auto" || value === "full" || value === "readonly") {
          config.permission = value;
          push(`permission mode: ${value}`, "ok");
        } else push("usage: /permission auto|full|readonly", "warn");
        return "ok";

      case "canary":
        if (value === "auto" || value === "off") {
          config.canary = value;
          push(`canary sign-off: ${value}`, "ok");
        } else push("usage: /canary auto|off", "warn");
        return "ok";

      case "provider":
        push(`provider: ${config.provider} (${config.providerSource}) · model: ${config.model}`, "dim");
        push(`endpoint: ${config.endpoint ?? "—"}`, "dim");
        push("to change it, leave and run `weaver setup`.", "dim");
        return "ok";

      case "session":
        push(`session ${meta.id} · ${state.messages.length} message(s)`, "dim");
        return "ok";

      case "sessions": {
        const sessions = listSessions(config.home);
        if (sessions.length === 0) push("no saved sessions yet.", "dim");
        else for (const session of sessions) push(`${session.id}  ${session.title}  (${session.model})`, "dim");
        return "ok";
      }

      default:
        push(`unknown command /${name} — try /help`, "warn");
        return "ok";
    }
  }

  // -------------------------------------------------------------------- render

  function render(): void {
    const frame = composeFrame({
      cols: stdout.columns ?? 80,
      rows: stdout.rows ?? 24,
      provider: config.provider,
      model: config.model,
      permission: config.permission,
      canary: config.canary,
      transcript,
      streaming,
      busy,
      status: statusText,
      spinner: SPINNER[spinnerIndex] ?? "⠋",
      elapsedMs: Date.now() - turnStart,
      input,
      cursor,
      scroll,
      pending: pending === null ? null : pending.question,
    });

    scroll = frame.scroll;

    stdout.write(encodeFrame(frame.lines, fullRepaint));
    fullRepaint = false;
  }

  function tick(): void {
    const cols = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    if (cols !== lastCols || rows !== lastRows) {
      lastCols = cols;
      lastRows = rows;
      fullRepaint = true;
      dirty = true;
    }
    if (busy) {
      spinnerIndex = (spinnerIndex + 1) % SPINNER.length;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      render();
    }
  }

  // ------------------------------------------------------------------ the turn

  function emit(event: AgentEvent): void {
    switch (event.type) {
      case "delta":
        streaming += event.text;
        statusText = "writing";
        dirty = true;
        return;

      case "assistant":
        if (streaming.trim().length > 0) pushAll(toLines(streaming.trimEnd(), "weaver"));
        streaming = "";
        statusText = "";
        return;

      case "tool-call":
        statusText = `running ${event.name}`;
        push(`→ ${event.name}  ${summarizeArgs(event.args)}`, "tool");
        return;

      case "tool-result":
        push(`${event.ok ? "✓" : "✕"} ${event.name} · ${event.ms}ms`, event.ok ? "ok" : "fail");
        for (const line of firstLines(event.output, 3)) push(`  ${line}`, "dim");
        statusText = "thinking";
        return;

      case "tool-denied":
        push(`⊘ ${event.name} denied — ${event.reason}`, "warn");
        return;

      case "notice":
        push(`· ${event.text}`, "notice");
        return;

      case "canary":
        pushCanary(event.report);
        return;

      case "error":
        if (/abort/i.test(event.message)) push("cancelled.", "warn");
        else push(`✕ ${event.message}`, "error");
        return;

      case "turn-end":
        statusText = "";
        return;
    }
  }

  const confirm: Confirm = (question) =>
    new Promise<ConfirmAnswer>((resolve) => {
      pending = { question, resolve };
      dirty = true;
    });

  function resolvePending(answer: ConfirmAnswer): void {
    const current = pending;
    pending = null;
    if (current !== null) {
      push(
        answer === "always" ? "always allowed." : answer === "yes" ? "allowed." : "declined.",
        answer === "no" ? "warn" : "ok",
      );
      current.resolve(answer);
    }
    dirty = true;
  }

  function persist(): void {
    if (state.messages.length === 0) return;
    try {
      saveSession(config.home, { meta, messages: state.messages });
    } catch {
      // Persistence is best-effort; it must never take the session down.
    }
  }

  async function startTurn(text: string): Promise<void> {
    if (meta.title === "untitled") meta.title = text.slice(0, 60);

    busy = true;
    statusText = "thinking";
    streaming = "";
    scroll = 0;
    turnStart = Date.now();
    push("", "dim");
    push(text, "user");
    dirty = true;

    const controller = new AbortController();
    abort = controller;

    try {
      await runTurn({ config, provider, tools, confirm, emit, signal: controller.signal }, state, text);
    } catch (err) {
      push(`✕ ${err instanceof Error ? err.message : String(err)}`, "error");
    }

    busy = false;
    abort = null;
    statusText = "";
    if (streaming.length > 0) {
      pushAll(toLines(streaming.trimEnd(), "weaver"));
      streaming = "";
    }
    persist();
    dirty = true;

    const next = queued;
    queued = null;
    if (next !== null) await startTurn(next);
  }

  // -------------------------------------------------------------------- input

  function insertText(text: string): void {
    if (text.length === 0) return;
    input = input.slice(0, cursor) + text + input.slice(cursor);
    cursor += text.length;
    dirty = true;
  }

  function submit(): void {
    const text = input.trim();
    if (text.length === 0) return;

    input = "";
    cursor = 0;
    historyIndex = -1;
    scroll = 0;
    dirty = true;

    if (history[history.length - 1] !== text) history.push(text);

    if (text.startsWith("/")) {
      if (command(text) === "exit") shutdown();
      return;
    }

    if (busy) {
      queued = text;
      push(`queued: ${text}`, "dim");
      return;
    }

    void startTurn(text);
  }

  function historyPrev(): void {
    if (history.length === 0) return;
    if (historyIndex === -1) historyIndex = history.length;
    if (historyIndex > 0) historyIndex -= 1;
    input = history[historyIndex] ?? "";
    cursor = input.length;
    dirty = true;
  }

  function historyNext(): void {
    if (history.length === 0 || historyIndex === -1) return;
    historyIndex += 1;
    if (historyIndex >= history.length) {
      historyIndex = -1;
      input = "";
    } else {
      input = history[historyIndex] ?? "";
    }
    cursor = input.length;
    dirty = true;
  }

  function handleCtrl(value: string): void {
    switch (value) {
      case "c": {
        if (busy) {
          abort?.abort();
          return;
        }
        if (input.length > 0) {
          input = "";
          cursor = 0;
          dirty = true;
          return;
        }
        const now = Date.now();
        if (now - lastInterrupt < 900) {
          shutdown();
          return;
        }
        lastInterrupt = now;
        push("press ctrl+c again to exit.", "dim");
        return;
      }
      case "d":
        if (input.length === 0) shutdown();
        return;
      case "l":
        transcript = [];
        streaming = "";
        scroll = 0;
        dirty = true;
        return;
      case "u": {
        input = input.slice(cursor);
        cursor = 0;
        dirty = true;
        return;
      }
      case "k": {
        input = input.slice(0, cursor);
        dirty = true;
        return;
      }
      case "w": {
        const before = input.slice(0, cursor).replace(/\s*\S+\s*$/, "");
        input = before + input.slice(cursor);
        cursor = before.length;
        dirty = true;
        return;
      }
      case "a":
        cursor = 0;
        dirty = true;
        return;
      case "e":
        cursor = input.length;
        dirty = true;
        return;
      default:
        return;
    }
  }

  function onKey(key: Key): void {
    if (pending !== null) {
      if (key.type === "char") {
        const ch = key.value.toLowerCase();
        if (ch === "y") return resolvePending("yes");
        if (ch === "n") return resolvePending("no");
        if (ch === "a") return resolvePending("always");
        return;
      }
      if (key.type === "enter" || key.type === "unknown") return resolvePending("no");
      if (key.type === "ctrl" && (key.value === "c" || key.value === "d")) return resolvePending("no");
      return;
    }

    switch (key.type) {
      case "char":
        insertText(key.value);
        return;
      case "paste":
        insertText(key.value.replace(/\s*\r?\n\s*/g, " "));
        return;
      case "enter":
        submit();
        return;
      case "backspace":
        if (cursor > 0) {
          input = input.slice(0, cursor - 1) + input.slice(cursor);
          cursor -= 1;
          dirty = true;
        }
        return;
      case "delete":
        if (cursor < input.length) {
          input = input.slice(0, cursor) + input.slice(cursor + 1);
          dirty = true;
        }
        return;
      case "left":
        if (cursor > 0) {
          cursor -= 1;
          dirty = true;
        }
        return;
      case "right":
        if (cursor < input.length) {
          cursor += 1;
          dirty = true;
        }
        return;
      case "home":
        cursor = 0;
        dirty = true;
        return;
      case "end":
        cursor = input.length;
        dirty = true;
        return;
      case "tab":
        return;
      case "up":
        if (input.length === 0) {
          scroll += 3;
          dirty = true;
        } else historyPrev();
        return;
      case "down":
        if (input.length === 0) {
          scroll = Math.max(0, scroll - 3);
          dirty = true;
        } else historyNext();
        return;
      case "pageup":
        scroll += 10;
        dirty = true;
        return;
      case "pagedown":
        scroll = Math.max(0, scroll - 10);
        dirty = true;
        return;
      case "ctrl":
        handleCtrl(key.value);
        return;
      case "unknown":
        // A bare escape cancels a running turn, or releases the scroll.
        if (key.raw === "\u001b") {
          if (busy) abort?.abort();
          else if (scroll !== 0) {
            scroll = 0;
            dirty = true;
          }
        }
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- lifecycle

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    if (timer !== undefined) clearInterval(timer);
    if (escapeTimer !== undefined) clearTimeout(escapeTimer);
    stdin.off("data", onData);
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
    stdin.pause();
    stdout.write(`${A.BRACKET_PASTE_OFF}${A.SHOW_CURSOR}${A.ALT_OFF}`);
  }

  function shutdown(): void {
    if (exiting) return;
    exiting = true;
    cleanup();
    persist();
    stdout.write(`${A.AMBER}weaver${A.RESET}${A.GRAY} — session ${meta.id} · ${config.home}${A.RESET}\n`);
    finish();
  }

  function onData(chunk: string): void {
    for (const key of parser.push(chunk)) onKey(key);

    if (parser.pending.length > 0) {
      if (escapeTimer !== undefined) clearTimeout(escapeTimer);
      escapeTimer = setTimeout(() => {
        for (const key of parser.flush()) onKey(key);
      }, ESCAPE_TIMEOUT_MS);
    }
  }

  // ------------------------------------------------------------------- start

  process.once("exit", cleanup);
  stdout.write(`${A.ALT_ON}${A.BRACKET_PASTE_ON}${A.HIDE_CURSOR}`);
  if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", onData);

  welcome();
  render();
  timer = setInterval(tick, TICK_MS);

  await done;
}
