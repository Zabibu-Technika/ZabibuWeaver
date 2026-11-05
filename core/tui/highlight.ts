// A small syntax highlighter, written for this renderer.
//
// No tree-sitter, no Prism, no dependency: a line-level scanner that finds strings,
// numbers, comments, and keywords. It is not a parser, and it does not pretend to be —
// multi-line block comments and template literals are outside its scope. What it does is
// make a code card legible, which is 90% of the visual benefit for 1% of the weight.
import type { Segment } from "./rich.ts";
import type { Style } from "./style.ts";

const TS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "switch",
  "case", "break", "continue", "class", "extends", "new", "this", "super", "import",
  "export", "from", "default", "async", "await", "try", "catch", "finally", "throw",
  "typeof", "instanceof", "interface", "type", "enum", "implements", "readonly", "public",
  "private", "protected", "static", "void", "null", "undefined", "true", "false", "in", "of",
]);

const PY_KEYWORDS = new Set([
  "def", "class", "return", "if", "elif", "else", "for", "while", "import", "from", "as",
  "with", "try", "except", "finally", "raise", "lambda", "in", "is", "not", "and", "or",
  "None", "True", "False", "async", "await", "yield", "pass", "break", "continue", "global",
]);

const BASH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
  "function", "in", "export", "local", "return", "exit", "echo", "cd", "source", "set",
]);

const GO_KEYWORDS = new Set([
  "func", "package", "import", "return", "if", "else", "for", "range", "switch", "case",
  "default", "struct", "interface", "var", "const", "type", "map", "chan", "go", "defer",
  "select", "nil", "true", "false",
]);

const RUST_KEYWORDS = new Set([
  "fn", "let", "mut", "pub", "use", "mod", "struct", "enum", "impl", "trait", "for",
  "while", "loop", "if", "else", "match", "return", "self", "Self", "crate", "super",
  "async", "await", "move", "ref", "const", "static", "true", "false",
]);

const JSON_KEYWORDS = new Set(["true", "false", "null"]);

interface Language {
  keywords: Set<string> | null;
  /** The comment marker for a line, or null when the language has none. */
  comment: "//" | "#" | null;
  /** JSON keys are strings followed by a colon. */
  json?: boolean;
}

const LANGUAGES: Record<string, Language> = {
  ts: { keywords: TS_KEYWORDS, comment: "//" },
  tsx: { keywords: TS_KEYWORDS, comment: "//" },
  js: { keywords: TS_KEYWORDS, comment: "//" },
  jsx: { keywords: TS_KEYWORDS, comment: "//" },
  json: { keywords: JSON_KEYWORDS, comment: null, json: true },
  py: { keywords: PY_KEYWORDS, comment: "#" },
  bash: { keywords: BASH_KEYWORDS, comment: "#" },
  sh: { keywords: BASH_KEYWORDS, comment: "#" },
  shell: { keywords: BASH_KEYWORDS, comment: "#" },
  go: { keywords: GO_KEYWORDS, comment: "//" },
  rust: { keywords: RUST_KEYWORDS, comment: "//" },
  rs: { keywords: RUST_KEYWORDS, comment: "//" },
};

function normalise(language: string | undefined): string {
  return (language ?? "").trim().toLowerCase();
}

function languageFor(name: string): Language {
  return (
    LANGUAGES[name] ??
    LANGUAGES[
      name === "typescript" ? "ts" : name === "javascript" ? "js" : name === "python" ? "py" : name === "golang" ? "go" : ""
    ] ?? { keywords: null, comment: null }
  );
}

/** Where a line comment starts, ignoring markers inside quotes. */
function commentIndex(line: string, marker: "//" | "#" | null): number {
  if (marker === null) return -1;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === undefined) continue;
    if (quote !== null) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (marker === "//" && character === "/" && line[index + 1] === "/") return index;
    if (marker === "#" && character === "#") return index;
  }
  return -1;
}

function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.style === segment.style) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

function styleForWord(word: string, language: Language, next: string): Style {
  if (language.keywords?.has(word) === true) return "keyword";
  if (next === "(") return "accent";
  return "code";
}

const TOKEN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;

export function highlight(line: string, languageName?: string): Segment[] {
  const name = normalise(languageName);
  if (name === "diff" || name === "patch") {
    const style: Style = line.startsWith("+")
      ? "ok"
      : line.startsWith("-")
        ? "fail"
        : line.startsWith("@@")
          ? "heading"
          : "code";
    return line.length === 0 ? [] : [{ text: line, style }];
  }

  const language = languageFor(name);
  const stop = commentIndex(line, language.comment);
  const code = stop === -1 ? line : line.slice(0, stop);
  const comment = stop === -1 ? "" : line.slice(stop);

  const segments: Segment[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(code)) !== null) {
    const token = match[0];
    if (match[1] !== undefined) {
      // A JSON key is a string in key position, not a value.
      let next = "";
      if (language.json === true) {
        let cursor = TOKEN.lastIndex;
        while (code[cursor] === " ") cursor += 1;
        next = code[cursor] ?? "";
      }
      segments.push({ text: token, style: language.json === true && next === ":" ? "accent" : "string" });
      continue;
    }
    if (match[2] !== undefined) {
      segments.push({ text: token, style: "number" });
      continue;
    }
    if (match[3] !== undefined) {
      let cursor = TOKEN.lastIndex;
      while (code[cursor] === " ") cursor += 1;
      segments.push({ text: token, style: styleForWord(token, language, code[cursor] ?? "") });
      continue;
    }
    // Whitespace and punctuation keep the surrounding code colour.
    segments.push({ text: token, style: "code" });
  }

  if (comment.length > 0) segments.push({ text: comment, style: "comment" });
  return merge(segments);
}
