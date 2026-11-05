// Recovering tool calls the model failed to make natively.
//
// This is the wound the old Zabibu Architect skeleton died of: Groq/Llama emitted
// things like `<function=create_new_folder {"folder_name": "x"}</function>` and the
// only handling was a regex run against the *error string*. Here the salvage is a
// first-class code path with a real parser, applied to the model's output.
import type { ToolCall } from "../core/types.ts";

let sequence = 0;

export function synthCallId(): string {
  sequence += 1;
  return `call_synth_${sequence}`;
}

/** Read a balanced {...} or [...] starting at `start`, respecting strings and escapes. */
export function readBalanced(text: string, start: number): { json: string; end: number } | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Pull tool calls out of free text. Handles the shapes open-weights models emit
 * when native tool calling fails:
 *   <function=name/>                      -> {}
 *   <function=name {json}></function>      -> json
 *   <function=name[]{"k":"v"}</function>   -> json
 *   <function=name {"a": {"b": 1}}         -> nested json survives
 */
export function extractToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const marker = /<function=([A-Za-z0-9_.:\-]+)/g;
  let match = marker.exec(text);

  while (match !== null) {
    const name = match[1] ?? "";
    let i = match.index + match[0].length;

    // Skip an optional `[]` and any whitespace between the name and the arguments.
    while (i < text.length && (text[i] === "[" || text[i] === "]" || /\s/.test(text[i] ?? ""))) {
      i += 1;
    }

    let args = "{}";
    if (text[i] === "{") {
      const balanced = readBalanced(text, i);
      if (balanced) args = balanced.json;
    }

    if (name.length > 0) {
      calls.push({ id: synthCallId(), type: "function", function: { name, arguments: args } });
    }
    match = marker.exec(text);
  }

  return calls;
}

function repair(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"'); // single-quoted strings
}

/** Parse tool arguments leniently — models sometimes send almost-JSON. */
export function parseArguments(raw: string | undefined): Record<string, unknown> {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return {};

  const candidates = [trimmed, repair(trimmed)];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
      return {};
    } catch {
      // try the repaired form
    }
  }
  throw new Error(`could not parse tool arguments: ${trimmed.slice(0, 160)}`);
}
