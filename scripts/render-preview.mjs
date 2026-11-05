// Render a representative Weaver frame to HTML, with the real ANSI colours converted to
// spans. This is a development artefact, not part of the product: it exists so the TUI can
// be reviewed in the Review pane without a terminal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeFrame, toLines } from "../src/tui/frame.ts";

const assistant = [
  "## The auth check, tightened",
  "",
  "The old path trusted **any** session cookie. I moved the check behind `verifySession`",
  "and added an expiry test.",
  "",
  "```ts",
  "export async function verifySession(token: string): Promise<Session | null> {",
  "  const claims = await decode(token); // signature + expiry",
  "  if (claims.exp < Date.now()) return null;",
  "  return claims;",
  "}",
  "```",
  "",
  "- rejects an expired token",
  "- keeps the public API stable",
  "",
  "I ran the existing suite; it passes.",
].join("\n");

const transcript = [
  { text: "you ▸ refactor the auth check to reject expired sessions", style: "user" },
  { text: "", style: "dim" },
  ...toLines(assistant, "weaver", { bullet: true }),
  { text: "", style: "dim" },
  { text: "  ● Read(src/core/auth.ts)", style: "tool" },
  { text: "    ✓ 18ms", style: "ok" },
  { text: "      lines 1-64 of 64", style: "dim" },
  { text: "", style: "dim" },
  { text: "  ● Edit(src/core/auth.ts)", style: "tool" },
  { text: "    ✓ 24ms", style: "ok" },
  { text: "      replaced 1 occurrence", style: "dim" },
  { text: "", style: "dim" },
  { text: "  ● Bash(npm test)", style: "tool" },
  { text: "    ✓ 2.4s", style: "ok" },
  { text: "      all tests passed", style: "dim" },
  { text: "", style: "dim" },
];

const input = {
  cols: 100,
  rows: 34,
  provider: "groq",
  model: "gpt-oss-120b",
  permission: "auto",
  canary: "auto",
  transcript,
  streaming: "",
  busy: false,
  status: "",
  spinner: "⠋",
  elapsedMs: 0,
  input: "",
  cursor: 0,
  scroll: 0,
  pending: null,
};

const { lines } = composeFrame(input);

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert the SGR subset Weaver emits into spans. */
function ansiToHtml(text) {
  let out = "";
  let open = 0;
  let last = 0;
  const pattern = /\u001b\[([0-9;]*)m/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, match.index));
    const params = (match[1] ?? "0").split(";").map((part) => Number(part));
    const [first, second, third, fourth, fifth] = params;

    if (first === 0) {
      out += "</span>".repeat(open);
      open = 0;
    } else if (first === 38 && second === 2) {
      out += `<span style="color:rgb(${third ?? 255},${fourth ?? 255},${fifth ?? 255})">`;
      open += 1;
    } else if (first === 48 && second === 2) {
      out += `<span style="background:rgb(${third ?? 0},${fourth ?? 0},${fifth ?? 0})">`;
      open += 1;
    } else if (first === 1) {
      out += '<span style="font-weight:700">';
      open += 1;
    } else if (first === 2) {
      out += '<span style="opacity:.62">';
      open += 1;
    } else if (first === 7) {
      out += '<span style="background:#e8e8e8;color:#101010">';
      open += 1;
    } else if (first === 90) {
      out += '<span style="color:#8a8a8a">';
      open += 1;
    } else if (first === 32) {
      out += '<span style="color:#5fbf7f">';
      open += 1;
    } else if (first === 31) {
      out += '<span style="color:#e05a5a">';
      open += 1;
    } else if (first === 33) {
      out += '<span style="color:#d9a441">';
      open += 1;
    } else if (first === 36) {
      out += '<span style="color:#63c7d6">';
      open += 1;
    } else if (first === 97) {
      out += '<span style="color:#f2f2f2">';
      open += 1;
    }
    last = pattern.lastIndex;
  }

  out += escapeHtml(text.slice(last));
  out += "</span>".repeat(open);
  return out;
}

const frameHtml = lines.map((line) => ansiToHtml(line)).join("\n");

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Weaver TUI — rendered frame</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #0b0d10; color: #d6d6d6;
         font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace; }
  .note { max-width: 92ch; color: #8a8a8a; font-family: system-ui, sans-serif; line-height: 1.5; }
  pre { margin: 24px 0 0; padding: 18px; background: #101317; border: 1px solid #23272e;
        border-radius: 10px; font-size: 13.5px; line-height: 1.35; overflow-x: auto;
        white-space: pre; }
</style>
<h2 style="font-family:system-ui,sans-serif;font-weight:600">Weaver — rendered frame</h2>
<p class="note">The real composeFrame output at 100×34, with its ANSI colours converted to spans.
Code cards carry token colours; tool calls are cards; the brand is a gradient.</p>
<pre>${frameHtml}</pre>
</html>
`;

mkdirSync(join(import.meta.dirname, "..", "docs"), { recursive: true });
writeFileSync(join(import.meta.dirname, "..", "docs", "tui.html"), html, "utf8");
console.log("wrote docs/tui.html");
