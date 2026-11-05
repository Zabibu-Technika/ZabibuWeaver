// Tests for the pieces the TUI is built out of: width maths, wrapping, and the
// raw-mode key parser. These are the parts that break silently in a terminal.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { displayWidth, padToWidth, RED, RESET, stripAnsi, truncate, wrapText } from "./ansi.ts";
import { KeyParser } from "./keys.ts";
import { loadConfig } from "../config.ts";

// ------------------------------------------------------------------ ansi

test("displayWidth ignores escape sequences", () => {
  assert.equal(displayWidth(`${RED}hello${RESET}`), 5);
  assert.equal(stripAnsi(`${RED}hello${RESET}`), "hello");
});

test("displayWidth counts wide characters as two cells", () => {
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("ab"), 2);
});

test("truncate never exceeds the requested width", () => {
  assert.equal(truncate("hello world", 5), "hello");
  assert.equal(truncate("日本語", 4), "日本");
  assert.equal(truncate("abc", 0), "");
  assert.equal(truncate("abc", 10), "abc");
});

test("padToWidth pads by visible width, not string length", () => {
  assert.equal(padToWidth(`${RED}ab${RESET}`, 4), `${RED}ab${RESET}  `);
  assert.equal(padToWidth("abcd", 2), "abcd");
});

test("wrapText wraps on words", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
});

test("wrapText hard-breaks a word longer than the line", () => {
  assert.deepEqual(wrapText("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("wrapText honours explicit newlines and empty lines", () => {
  assert.deepEqual(wrapText("a\nb", 10), ["a", "b"]);
  assert.deepEqual(wrapText("", 10), [""]);
  assert.deepEqual(wrapText("a\n\nb", 10), ["a", "", "b"]);
});

// ------------------------------------------------------------------ keys

test("KeyParser reads printable characters", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("ab"), [
    { type: "char", value: "a" },
    { type: "char", value: "b" },
  ]);
});

test("KeyParser maps control bytes", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\r"), [{ type: "enter" }]);
  assert.deepEqual(parser.push("\u007f"), [{ type: "backspace" }]);
  assert.deepEqual(parser.push("\u0003"), [{ type: "ctrl", value: "c" }]);
  assert.deepEqual(parser.push("\u000c"), [{ type: "ctrl", value: "l" }]);
  assert.deepEqual(parser.push("\u0015"), [{ type: "ctrl", value: "u" }]);
});

test("KeyParser reads arrow and navigation sequences", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b[A"), [{ type: "up" }]);
  assert.deepEqual(parser.push("\u001b[B"), [{ type: "down" }]);
  assert.deepEqual(parser.push("\u001b[C"), [{ type: "right" }]);
  assert.deepEqual(parser.push("\u001b[D"), [{ type: "left" }]);
  assert.deepEqual(parser.push("\u001b[H"), [{ type: "home" }]);
  assert.deepEqual(parser.push("\u001b[3~"), [{ type: "delete" }]);
  assert.deepEqual(parser.push("\u001b[5~"), [{ type: "pageup" }]);
  assert.deepEqual(parser.push("\u001b[6~"), [{ type: "pagedown" }]);
});

test("KeyParser buffers a sequence split across two reads", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b"), []);
  assert.deepEqual(parser.push("["), []);
  assert.deepEqual(parser.push("A"), [{ type: "up" }]);
  assert.equal(parser.pending, "");
});

test("KeyParser flushes a lone escape as the escape key", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b"), []);
  assert.equal(parser.pending, "\u001b");
  assert.deepEqual(parser.flush(), [{ type: "unknown", raw: "\u001b" }]);
  assert.equal(parser.pending, "");
});

test("KeyParser reads a bracketed paste as a single key", () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.push("\u001b[200~hi\nthere\u001b[201~"), [
    { type: "paste", value: "hi\nthere" },
  ]);
});

// ------------------------------------------------------------------ config

const PROVIDER_ENV = [
  "WEAVER_PROVIDER",
  "WEAVER_MODEL",
  "WEAVER_API_KEY",
  "WEAVER_BASE_URL",
  "WEAVER_WORKSPACE",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "TOGETHER_API_KEY",
];

/** Run `body` with every provider-related variable cleared and a clean home. */
function withoutProviderEnv(body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of PROVIDER_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }

  const home = mkdtempSync(join(tmpdir(), "weaver-config-"));
  process.env.WEAVER_HOME = home;

  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.WEAVER_HOME;
    rmSync(home, { recursive: true, force: true });
  }
}

test("config falls back to a keyless endpoint when nothing is configured", () => {
  withoutProviderEnv(() => {
    const cfg = loadConfig();
    assert.equal(cfg.provider, "pollinations");
    assert.equal(cfg.providerSource, "default");
    assert.equal(cfg.endpoint, "https://text.pollinations.ai/openai");
    assert.equal(cfg.apiKey, "", "the keyless provider must not invent a key");
  });
});

test("config auto-detects a key that is already in the environment", () => {
  withoutProviderEnv(() => {
    process.env.GROQ_API_KEY = "test-groq-key";
    const cfg = loadConfig();
    assert.equal(cfg.provider, "groq");
    assert.equal(cfg.providerSource, "detected");
    assert.equal(cfg.apiKey, "test-groq-key");
    assert.equal(cfg.endpoint, "https://api.groq.com/openai/v1/chat/completions");
  });
});

test("an explicit provider never needs a key to load", () => {
  withoutProviderEnv(() => {
    const cfg = loadConfig({ provider: "ollama" });
    assert.equal(cfg.provider, "ollama");
    assert.equal(cfg.providerSource, "flag");
    assert.equal(cfg.endpoint, "http://localhost:11434/v1/chat/completions");
  });
});
