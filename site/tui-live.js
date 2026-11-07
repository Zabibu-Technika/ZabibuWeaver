(() => {
  "use strict";

  const shell = document.getElementById("weaver-demo");
  if (!shell) return;

  const transcript = document.getElementById("tui-transcript");
  const input = document.getElementById("tui-input");
  const palette = document.getElementById("tui-palette");
  const statusLeft = document.getElementById("tui-status-left");
  const statusRight = document.getElementById("tui-status-right");

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, reduced ? 0 : ms));
  const esc = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const initial = () => ({
    provider: "groq",
    model: "gpt-oss-120b",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    permission: "auto",
    canary: "auto",
    session: "zbyx-7f3a",
    busy: false,
    cancelled: false,
    alwaysAllow: false,
    awaiting: null,
    history: [],
    historyIndex: 0,
    lastCheckpoint: null,
    pendingUndo: false,
    changed: false,
    accounts: {
      github: { active: "teh317", list: ["teh317", "zabibu-ops"] },
      vercel: { active: "Zabibu Technika's projects", list: ["Zabibu Technika's projects", "personal"] },
    },
  });

  let state = initial();
  let paletteNavigated = false;

  const commands = [
    ["/help", "commands and keys", "tui"],
    ["/tools", "tools the agent can use", "tui"],
    ["/permission auto|full|readonly", "change the gate", "tui"],
    ["/canary auto|off", "change the sign-off", "tui"],
    ["/provider", "current endpoint and model", "tui"],
    ["/checkpoints", "what can be undone", "tui"],
    ["/undo", "preview an undo; /undo yes applies", "tui"],
    ["/sessions", "saved sessions", "tui"],
    ["/clear", "wipe the transcript", "tui"],
    ["/exit", "leave the session", "tui"],
    ["/providers", "every endpoint and its key state", "cli"],
    ["/models", "models for the active provider", "cli"],
    ["/verify", "run the project checks", "cli"],
    ["/receipts", "proof receipts", "cli"],
    ["/decisions", "the decision ledger", "cli"],
    ["/integrations", "GitHub / Vercel accounts", "cli"],
    ["/lsp", "language-server diagnostics and symbols", "cli"],
    ["/mcp", "configured MCP servers and tools", "cli"],
    ["/subagent", "read-only research in a child context", "cli"],
    ["/setup", "device-aware model setup", "cli"],
    ["/about", "license, source, dependencies", "cli"],
  ];

  function append(html, cls = "") {
    const line = document.createElement("div");
    line.className = "tui-line" + (cls ? " " + cls : "");
    line.innerHTML = html;
    transcript.appendChild(line);
    transcript.scrollTop = transcript.scrollHeight;
    return line;
  }

  function text(value, cls = "") {
    return append(esc(value).replace(/\n/g, "<br>"), cls);
  }

  function block(value, cls = "tui-block") {
    return append(`<pre class="${cls}">${esc(value)}</pre>`);
  }

  function renderStatus() {
    statusRight.textContent = `${state.provider}/${state.model} · ${state.permission} · canary ${state.canary}`;
  }

  function setStatus(value, busy = false) {
    statusLeft.textContent = value;
    statusLeft.classList.toggle("busy", busy);
  }

  function welcome() {
    transcript.innerHTML = "";
    append(
      '<span class="tui-brand">WEAVER</span> <span class="dim">v0.8.1 · the local-first coding agent</span>',
      "heading",
    );
    append(
      '<span class="dim">provider</span> groq/openai-gpt-oss-120b · <span class="dim">permission</span> auto · <span class="dim">canary</span> auto',
      "dim",
    );
    append("");
    append(
      'Type a task, or <span class="accent">/help</span>. This is an <span class="paper">interactive browser demo</span> — no code runs on your machine.',
      "notice",
    );
    append(
      'Try <span class="accent">fix the failing test</span> · <span class="accent">write a test</span> · <span class="accent">/checkpoints</span> · <span class="accent">/integrations</span>',
      "dim",
    );
    append("");
    renderStatus();
    setStatus("enter send · /help · ↑↓ history");
  }

  function resetDemo() {
    state = initial();
    welcome();
    input.value = "";
    hidePalette();
    input.focus();
  }

  function submit(raw) {
    const value = raw.trim();
    if (value.length === 0) return;

    state.history.push(value);
    state.historyIndex = state.history.length;
    input.value = "";
    hidePalette();

    append(`<span class="tui-prompt-inline">you ›</span> ${esc(value)}`, "user");

    if (state.awaiting) {
      handleAwaiting(value);
      return;
    }
    if (value === "?") {
      showHelp();
      return;
    }
    if (value.startsWith("/")) {
      void runCommand(value);
      return;
    }
    void runTask(value);
  }

  function showHelp() {
    block(
      [
        "commands (TUI)",
        "  /help                 this list",
        "  /tools                tools the agent can use",
        "  /permission <mode>    auto | full | readonly",
        "  /canary <mode>        auto | off",
        "  /provider             current endpoint and model",
        "  /session              current session id",
        "  /sessions             saved sessions",
        "  /checkpoints          what can be undone",
        "  /undo [id|yes]        preview, then apply an undo",
        "  /clear                wipe the transcript",
        "  /exit                 leave the session",
        "",
        "cli surface (demo)",
        "  /providers            every endpoint and its key state",
        "  /models               models for the active provider",
        "  /verify               run the project checks",
        "  /receipts             proof receipts",
        "  /decisions            the decision ledger",
        "  /integrations         GitHub / Vercel accounts",
        "  /lsp <action> <file>  diagnostics / definition / references / hover",
        "  /mcp list|call        configured MCP servers and tools",
        "  /subagent <prompt>    read-only research in a child context",
        "  /setup                device-aware model setup",
        "",
        "keys",
        "  enter send · esc / ctrl+c cancel · ctrl+l clear · ↑↓ history",
        "",
        "Lines marked cli are `weaver <cmd>` in the real binary; they are shown here",
        "so the demo covers the whole surface. The sandbox never executes code.",
      ].join("\n"),
    );
  }

  async function runCommand(raw) {
    const parts = raw.slice(1).trim().split(/\s+/);
    const name = (parts[0] ?? "").toLowerCase();
    const value = parts.slice(1).join(" ").trim();

    switch (name) {
      case "help":
        showHelp();
        return;

      case "tools":
        block(
          [
            "read_file    read    Read a file inside the workspace",
            "write_file   writes  Write a new file",
            "edit_file    writes  Replace an exact string in a file",
            "list_dir     read    List a directory",
            "glob_files   read    Find files by pattern",
            "grep         read    Search file contents",
            "run_shell    writes  Run a shell command (asks first in auto mode)",
          ].join("\n"),
        );
        return;

      case "permission":
        if (!["auto", "full", "readonly"].includes(value)) {
          append("usage: /permission auto|full|readonly", "warn");
          return;
        }
        state.permission = value;
        renderStatus();
        append(`permission mode: ${value}`, "ok");
        return;

      case "canary":
        if (!["auto", "off"].includes(value)) {
          append("usage: /canary auto|off", "warn");
          return;
        }
        state.canary = value;
        renderStatus();
        append(`canary sign-off: ${value}`, "ok");
        return;

      case "provider":
        append(`provider: ${esc(state.provider)} (config) · model: ${esc(state.model)}`, "dim");
        append(`endpoint: ${esc(state.endpoint)}`, "dim");
        append("to change it, leave and run `weaver setup`.", "dim");
        return;

      case "session":
        append(`session ${esc(state.session)} · demo transcript`, "dim");
        return;

      case "sessions":
        block(
          [
            "zbyx-7f3a  fix the failing test        groq/gpt-oss-120b",
            "zbyx-6c21  refactor the auth check     groq/gpt-oss-120b",
            "zbyx-4a90  explain the billing flow    ollama/qwen2.5-coder:7b",
          ].join("\n"),
        );
        return;

      case "checkpoints":
        if (state.lastCheckpoint === null) {
          append("no checkpoints yet — one is taken before any change.", "dim");
          return;
        }
        block(
          [
            `${state.lastCheckpoint}  edit_file   src/core/auth.ts`,
            "20261107T214400000-a1b2c  run_shell   workspace sweep",
            "",
            "restore with /undo (preview) then /undo yes.",
          ].join("\n"),
        );
        return;

      case "undo":
        handleUndo(value);
        return;

      case "decisions":
        block(
          [
            "[choice]     Use ~/.weaver/workspace as the base workspace",
            "[rejection]  Do not add a telemetry SDK",
            "[constraint] No runtime npm dependencies",
            "[assumption] The project's checks are the source of truth",
            "",
            "Append-only. Superseding an entry keeps the trail.",
          ].join("\n"),
        );
        return;

      case "receipts":
        block(
          [
            "20261107T214500000-zbyxm  proved    3/3 checks  src/core/auth.ts",
            "20261107T213000000-a1b2c  partial   2/2 checks  test authored this turn",
            "20261107T212000000-c3d4e  unproven  0 checks    read-only turn",
            "",
            "Output is not stored. The digest binds the receipt to what ran.",
          ].join("\n"),
        );
        return;

      case "verify":
        await demoVerify();
        return;

      case "integrations":
        handleIntegrations(value);
        return;

      case "lsp":
        await demoLsp(value);
        return;

      case "mcp":
        await demoMcp(value);
        return;

      case "subagent":
        await demoSubagent(value);
        return;

      case "setup":
        block(
          [
            "device     Windows 11 x64 · 2 cores / 4 threads · 7.8 GB RAM",
            "disk       4.2 GB free",
            "admin      no",
            "recommend  qwen2.5-coder:7b (Ollama) — fits with headroom",
            "command    ollama pull qwen2.5-coder:7b",
            "permission auto — writes still ask",
            "",
            "Demo values. The real setup reads this machine.",
          ].join("\n"),
        );
        return;

      case "providers":
        block(
          [
            "pollinations  free   keyless default",
            "groq          free   key set (demo)",
            "gemini        free   key missing",
            "openrouter    free   key missing",
            "ollama        local  runs on this machine",
            "openai        paid   key missing",
            "together      free   key missing",
          ].join("\n"),
        );
        return;

      case "models":
        block(
          [
            "groq",
            "  openai/gpt-oss-120b   default",
            "  openai/gpt-oss-20b",
            "  qwen/qwen3.8-27b",
            "ollama",
            "  qwen2.5-coder:7b      recommended for this machine",
          ].join("\n"),
        );
        return;

      case "about":
        block(
          [
            "Weaver 0.8.1 — MIT — github.com/Zabibu-Technika/ZabibuWeaver",
            "zero runtime npm dependencies · one Windows download includes Node 24",
            "no account · no vendor model · local-first",
          ].join("\n"),
        );
        return;

      case "clear":
        transcript.innerHTML = "";
        append("transcript cleared. Type /help or a task.", "dim");
        return;

      case "exit":
        append("This is a browser demo; /exit does not close the page. Use Reset to start over.", "warn");
        return;

      case "reset":
        resetDemo();
        return;

      default:
        append(`unknown command /${esc(name)} — try /help`, "warn");
    }
  }

  function handleUndo(value) {
    if (value === "yes") {
      if (!state.pendingUndo || state.lastCheckpoint === null) {
        append("nothing staged — run /undo first.", "warn");
        return;
      }
      append("restored src/core/auth.ts (hash 4f2c…)", "ok");
      append("removed src/core/auth.tmp (created by this turn)", "ok");
      append("undo applied. The checkpoint is kept.", "dim");
      state.pendingUndo = false;
      state.lastCheckpoint = null;
      state.changed = false;
      return;
    }

    if (value === "cancel") {
      state.pendingUndo = false;
      append("undo cancelled — nothing changed.", "dim");
      return;
    }

    if (state.lastCheckpoint === null) {
      append("nothing to undo — no checkpoints yet.", "dim");
      return;
    }

    append(`checkpoint ${state.lastCheckpoint}`, "heading");
    append("restore  src/core/auth.ts     1 file, +3/−1", "dim");
    append("delete   src/core/auth.tmp    created by this turn", "warn");
    append("type /undo yes to apply · /undo cancel to leave it", "dim");
    state.pendingUndo = true;
  }

  function handleIntegrations(value) {
    if (value.startsWith("use ")) {
      const [provider, ...rest] = value.slice(4).trim().split(/\s+/);
      const account = rest.join(" ");
      const entry = state.accounts[provider];
      if (!entry || !entry.list.includes(account)) {
        append("usage: /integrations use github|vercel <account>", "warn");
        return;
      }
      entry.active = account;
      append(`switched ${provider} to ${account} (demo).`, "ok");
      append("the real command is `weaver integrations use <id> <account>`.", "dim");
      return;
    }

    block(
      [
        "GitHub",
        `  ● ${state.accounts.github.active}        active · selected`,
        `    ${state.accounts.github.list.filter((a) => a !== state.accounts.github.active).join("\n    ")}`,
        "Vercel",
        `  ● ${state.accounts.vercel.active}  active · selected`,
        `    ${state.accounts.vercel.list.filter((a) => a !== state.accounts.vercel.active).join("\n    ")}`,
        "",
        "switch: /integrations use github zabibu-ops",
        "the real command is `weaver integrations use <id> <account>`.",
      ].join("\n"),
    );
  }

  async function demoVerify() {
    setStatus("⠙ running checks", true);
    await wait(650);
    append("detected checks: typecheck, test, lint", "dim");
    append("pytest is detected when pytest.ini, a [tool.pytest] config, or tests/*.py exists.", "dim");
    append("typecheck  PASS  0  1.1s", "ok");
    append("test       PASS  0  2.4s", "ok");
    append("lint       PASS  0  0.8s", "ok");
    append("verification passed — 3/3 checks", "ok");
    append("proof: proved — 3/3 checks passed", "ok");
    append("  .weaver/receipts/20261107T214500000-zbyxm.md", "dim");
    setStatus("enter send · /help · ↑↓ history");
  }

  async function demoLsp(value) {
    const action = value.trim().split(/\s+/)[0] || "diagnostics";
    setStatus("⠙ running lsp", true);
    await wait(650);
    if (action === "definition" || action === "references") {
      append("src/core/auth.ts:42:7", "ok");
      append("src/core/auth.ts:58:3", "dim");
      append("2 location(s) returned by the language server.", "dim");
    } else if (action === "hover") {
      append("verifySession(token: string): Promise<Session | null>", "ok");
      append("Checks the signature and expiry before returning claims.", "dim");
    } else {
      append("src/core/auth.ts:42:7 warning [typescript] 'token' is possibly undefined.", "warn");
      append("src/core/auth.ts:58:3 hint [typescript] The expiry check is not covered by a test.", "dim");
      append("2 diagnostic(s) published by the language server.", "dim");
    }
    append("requires .weaver/lsp.json or a language server on PATH; the demo does not execute one.", "dim");
    setStatus("enter send · /help · ↑↓ history");
  }

  async function demoMcp(value) {
    setStatus("⠙ running mcp", true);
    await wait(650);
    if (value.trim().startsWith("call")) {
      append("mcp__filesystem__read_file → read 42 bytes from src/core/auth.ts", "ok");
      append("result is marked external: MCP output can carry untrusted instructions.", "dim");
    } else {
      block(
        [
          "configured MCP servers",
          "  filesystem",
          "    mcp__filesystem__read_file   read    read a file",
          "    mcp__filesystem__write_file  writes  write a file (the gate asks first)",
          "",
          "configured in .weaver/mcp.json. Unknown capabilities default to asking.",
          "the demo does not start a real server.",
        ].join("\n"),
      );
    }
    setStatus("enter send · /help · ↑↓ history");
  }

  async function demoSubagent(value) {
    setStatus("⠙ running subagent", true);
    await wait(750);
    toolCard("Subagent", "research the auth expiry path", "3 tool calls", "read-only child context; no files changed");
    append(
      "The expiry check is missing in <span class='accent'>src/core/auth.ts:42</span>. The current tests do not cover an expired session. Recommended first change: add an expiry test, then fix the check.",
      "weaver",
    );
    append("The subagent had read/search/LSP tools only, a 6-step budget, and no ability to write.", "dim");
    setStatus("enter send · /help · ↑↓ history");
  }

  async function askPermission(tool, path) {
    if (state.permission === "full") {
      append(`permission full — ${esc(tool)} allowed`, "dim");
      return true;
    }
    if (state.permission === "readonly") {
      append(`permission readonly — ${esc(tool)} denied`, "warn");
      return false;
    }
    if (state.alwaysAllow) {
      append(`always allowed this turn — ${esc(tool)}`, "dim");
      return true;
    }

    append(
      `<span class="warn">allow ${esc(tool)}(${esc(path)})?</span> <span class="dim">[y] yes  [n] no  [a] always</span>`,
      "warn",
    );
    setStatus("waiting for permission", true);
    return new Promise((resolve) => {
      state.awaiting = { kind: "permission", tool, path, resolve };
    });
  }

  function handleAwaiting(value) {
    const awaiting = state.awaiting;
    if (!awaiting) return;

    if (awaiting.kind === "permission") {
      const answer = value.toLowerCase();
      if (!["y", "yes", "n", "no", "a", "always"].includes(answer)) {
        append("answer y, n, or a", "warn");
        return;
      }
      state.awaiting = null;
      const ok = answer[0] === "y" || answer[0] === "a";
      if (answer[0] === "a") state.alwaysAllow = true;
      append(
        `<span class="${ok ? "ok" : "warn"}">${ok ? "approved" : "denied"} ${esc(awaiting.tool)}(${esc(awaiting.path)})</span>`,
        ok ? "ok" : "warn",
      );
      awaiting.resolve(ok);
      setStatus("enter send · /help · ↑↓ history");
    }
  }

  function toolCard(label, argument, ms, detail) {
    append(`<span class="tool">  ● ${esc(label)}(${esc(argument)})</span>`, "tool");
    append(`<span class="ok">    ✓ ${esc(ms)}</span>`, "ok");
    if (detail) append(`<span class="dim">      ${esc(detail)}</span>`, "dim");
    append("");
  }

  async function pause(ms) {
    await wait(ms);
    if (state.cancelled) throw new Error("cancelled");
  }

  async function runTask(value) {
    if (state.busy) {
      append("wait for the current turn to finish (or press ctrl+c).", "warn");
      return;
    }

    state.busy = true;
    state.cancelled = false;
    state.alwaysAllow = false;

    try {
      const lower = value.toLowerCase();
      if (/(delete|wipe|drop|truncate|rm\s+-rf).*(all|users|database|table|repo|everything)/.test(lower)) {
        await scenarioScopeStop(value);
      } else if (/(refactor|rewrite|redesign|restructure).*(everything|whole|entire|all)/.test(lower)) {
        await scenarioBroadScope(value);
      } else if (/(npm\s+install|pip\s+install|add\s+.*depend|install\s+.*package)/.test(lower)) {
        await scenarioDependency(value);
      } else if (/(deploy|publish|production|release)/.test(lower)) {
        await scenarioEgress(value);
      } else if (/(write|add|create).*(test|spec)/.test(lower)) {
        await scenarioSelfAuthored(value);
      } else if (/(fix|bug|failing|test.*fail|broken)/.test(lower)) {
        await scenarioFix(value);
      } else if (/(subagent|delegate)/.test(lower)) {
        await demoSubagent(value);
      } else if (/(lsp|diagnostic|definition|references|hover)/.test(lower)) {
        await demoLsp(value);
      } else if (/\bmcp\b/.test(lower)) {
        await demoMcp(value);
      } else if (/(explain|what|how|why|read|review)/.test(lower)) {
        await scenarioExplain(value);
      } else {
        await scenarioGeneric(value);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "cancelled") {
        append("cancelled. No further actions were taken.", "warn");
      } else {
        append(`demo error: ${esc(error instanceof Error ? error.message : String(error))}`, "fail");
      }
    } finally {
      state.busy = false;
      state.cancelled = false;
      state.awaiting = null;
      setStatus("enter send · /help · ↑↓ history");
      input.focus();
    }
  }

  async function scenarioFix(value) {
    setStatus("⠙ thinking", true);
    await pause(450);
    setStatus("⠙ running read_file", true);
    toolCard("Read", "src/core/auth.ts", "18ms", "lines 1–64 of 64");

    const allowed = await askPermission("edit_file", "src/core/auth.ts");
    if (!allowed) {
      append("turn stopped — no files changed.", "warn");
      return;
    }

    setStatus("⠙ running edit_file", true);
    await pause(350);
    toolCard("Edit", "src/core/auth.ts", "24ms", "replaced 1 occurrence");

    setStatus("⠙ running run_shell", true);
    await pause(450);
    toolCard("Bash", "npm test", "2.4s", "all tests passed");

    append("verification passed · attempt 1 · 3 check(s)", "ok");
    append("proof: proved — 3/3 checks passed", "ok");
    append("  .weaver/receipts/20261107T214500000-zbyxm.md", "dim");
    append(
      "The expiry check is in place. The suite passes. Try <span class='accent'>/checkpoints</span> to inspect the undo, or <span class='accent'>/receipts</span> for the proof.",
      "weaver",
    );
    state.lastCheckpoint = "20261107T214500000-zbyxm";
    state.changed = true;
  }

  async function scenarioSelfAuthored(value) {
    setStatus("⠙ thinking", true);
    await pause(400);
    const allowed = await askPermission("write_file", "src/core/auth.test.ts");
    if (!allowed) {
      append("turn stopped — no files changed.", "warn");
      return;
    }

    setStatus("⠙ running write_file", true);
    await pause(350);
    toolCard("Write", "src/core/auth.test.ts", "21ms", "38 lines");

    setStatus("⠙ running run_shell", true);
    await pause(400);
    toolCard("Bash", "npm test", "2.1s", "all tests passed");

    append("verification passed · attempt 1 · 2 check(s)", "ok");
    append("proof: partial — the turn edited the test file", "warn");
    append("  self-authored checks: yes — the run is not independent", "dim");
    append(
      "The tests pass, but the proof is partial on purpose: this turn authored the test that judged it.",
      "weaver",
    );
    state.lastCheckpoint = "20261107T214600000-a1b2c";
    state.changed = true;
  }

  async function scenarioScopeStop(value) {
    setStatus("⠙ scope check", true);
    await pause(350);
    append("scope check: stop — a destructive verb is aimed at a whole scope.", "warn");
    append(
      "I won’t run that. Name the exact table/rows and the backup, or ask for a read-only inventory first.",
      "warn",
    );
    append("No files changed. No receipt written.", "dim");
  }

  async function scenarioBroadScope(value) {
    setStatus("⠙ scope check", true);
    await pause(350);
    append("scope check: stop — a broad rewrite or more than one objective.", "warn");
    append("Which one file or behavior should change first? Give me a named target and a success check.", "warn");
    append("No files changed. No receipt written.", "dim");
  }

  async function scenarioDependency(value) {
    setStatus("⠙ scope check", true);
    await pause(350);
    append("scope check: caution — this adds a dependency.", "warn");
    append("Is it acceptable to expand the supply chain, or can this be done with what is already here?", "warn");
    append("No files changed. No receipt written.", "dim");
  }

  async function scenarioEgress(value) {
    setStatus("⠙ scope check", true);
    await pause(350);
    append("scope check: caution — this reaches outside the machine, where undo is not a file operation.", "warn");
    append("Deploy or publish needs explicit approval and a compensation plan. The demo stops here.", "warn");
    append("No files changed. No receipt written.", "dim");
  }

  async function scenarioExplain(value) {
    setStatus("⠙ thinking", true);
    await pause(500);
    append(
      "The auth path reads a session token, verifies the signature, checks expiry, and returns the claims. The weak point is the expiry check; the test suite does not cover it yet.",
      "weaver",
    );
    append("No files changed. No proof receipt was written — there is nothing to prove.", "dim");
  }

  async function scenarioGeneric(value) {
    setStatus("⠙ thinking", true);
    await pause(500);
    append(
      "I would read the relevant files, propose the smallest change, run the project checks, and leave a receipt. Try a demo task or /help for the full command surface.",
      "weaver",
    );
  }

  function history(direction) {
    if (state.history.length === 0) return;
    state.historyIndex = Math.max(0, Math.min(state.history.length, state.historyIndex + direction));
    input.value = state.history[state.historyIndex] ?? "";
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function hidePalette() {
    palette.hidden = true;
    palette.innerHTML = "";
    paletteNavigated = false;
  }

  function showPalette() {
    const value = input.value.trim();
    if (!value.startsWith("/") || value.includes(" ")) {
      hidePalette();
      return;
    }
    const query = value.slice(1).toLowerCase();
    const matches = commands.filter(([command, description]) =>
      command.slice(1).toLowerCase().startsWith(query) || description.toLowerCase().includes(query),
    );
    if (matches.length === 0) {
      hidePalette();
      return;
    }
    palette.innerHTML = matches
      .map(
        ([command, description, kind], index) =>
          `<button type="button" data-command="${command}" class="${index === 0 ? "active" : ""}"><b>${command}</b><span>${kind} · ${description}</span></button>`,
      )
      .join("");
    palette.hidden = false;
    paletteNavigated = false;
  }

  function movePalette(direction) {
    const buttons = [...palette.querySelectorAll("button")];
    if (buttons.length === 0) return;
    const current = buttons.findIndex((button) => button.classList.contains("active"));
    const next = (current + direction + buttons.length) % buttons.length;
    buttons.forEach((button, index) => button.classList.toggle("active", index === next));
    paletteNavigated = true;
  }

  input.addEventListener("input", showPalette);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const typed = input.value.trim();
      const exact = commands.some(([command]) => command === typed);
      if (!palette.hidden && paletteNavigated && !exact) {
        const active = palette.querySelector("button.active");
        if (active) {
          input.value = active.dataset.command;
          hidePalette();
          submit(input.value);
          return;
        }
      }
      submit(input.value);
      return;
    }

    if (event.key === "ArrowDown" && !palette.hidden) {
      event.preventDefault();
      movePalette(1);
      return;
    }
    if (event.key === "ArrowUp" && !palette.hidden) {
      event.preventDefault();
      movePalette(-1);
      return;
    }
    if (event.key === "Escape") {
      hidePalette();
      return;
    }
    if (event.key === "ArrowUp" && palette.hidden) {
      event.preventDefault();
      history(-1);
      return;
    }
    if (event.key === "ArrowDown" && palette.hidden) {
      event.preventDefault();
      history(1);
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      transcript.innerHTML = "";
      append("transcript cleared. Type /help or a task.", "dim");
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (state.busy) {
        state.cancelled = true;
        append("cancel requested — the demo stops after the current step.", "warn");
      } else {
        input.value = "";
        hidePalette();
      }
    }
  });

  palette.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-command]");
    if (!button) return;
    input.value = button.dataset.command;
    hidePalette();
    submit(input.value);
  });

  shell.addEventListener("click", (event) => {
    if (event.target.closest("button, input, a")) return;
    input.focus();
  });

  shell.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-demo]");
    if (!chip) return;
    event.preventDefault();

    if (chip.dataset.demo === "reset") {
      resetDemo();
      return;
    }
    if (state.busy || state.awaiting) {
      append("finish the current prompt first (or press ctrl+c).", "warn");
      return;
    }

    if (chip.dataset.demo === "fix") {
      input.value = "fix the failing test";
    } else if (chip.dataset.demo === "test") {
      input.value = "write a test for the auth check";
    } else if (chip.dataset.demo === "scope") {
      input.value = "delete all users";
    } else if (chip.dataset.demo === "lsp") {
      void (async () => {
        await runCommand("/lsp diagnostics src/core/auth.ts");
        await runCommand("/mcp list");
      })();
      return;
    } else if (chip.dataset.demo === "subagent") {
      void runCommand("/subagent review the auth flow");
      return;
    } else if (chip.dataset.demo === "checkpoints") {
      state.lastCheckpoint = "20261107T214500000-zbyxm";
      state.changed = true;
      append("A change has been checkpointed (demo).", "dim");
      void runCommand("/checkpoints");
      return;
    } else if (chip.dataset.demo === "integrations") {
      void runCommand("/integrations");
      return;
    }

    submit(input.value);
  });

  welcome();
})();
