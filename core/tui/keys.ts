// Raw-mode key parsing: bytes in, semantic keys out.
//
// Terminals deliver input as a byte soup. Arrow keys arrive as escape sequences
// that may be split across two reads, so the parser buffers until it can tell
// whether it has a complete sequence. `flush` handles the ambiguous case: a lone
// ESC is the escape key, not the start of anything.

export type Key =
  | { type: "char"; value: string }
  | { type: "paste"; value: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "tab" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "ctrl"; value: string }
  | { type: "unknown"; raw: string };

type ArrowOrNav = "left" | "right" | "up" | "down" | "home" | "end";

/** The `CSI n ~` family. Narrower than `Key["type"]` on purpose: these tags
 *  carry no payload, so they must not widen into the char/paste variants. */
type TildeNav = "home" | "end" | "delete" | "pageup" | "pagedown";

const CSI_FINAL: Record<string, ArrowOrNav> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_TILDE: Record<string, TildeNav> = {
  "1": "home",
  "2": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

const CONTROL_KEYS: Record<number, string> = {
  0x01: "a",
  0x03: "c",
  0x04: "d",
  0x05: "e",
  0x0b: "k",
  0x0c: "l",
  0x15: "u",
  0x17: "w",
};

/** How long an unterminated escape sequence waits before it is read as ESC. */
export const ESCAPE_TIMEOUT_MS = 30;

interface Step {
  key: Key | null;
  length: number;
}

export class KeyParser {
  private buffered = "";

  /** Input that is waiting for more bytes before it can be interpreted. */
  get pending(): string {
    return this.buffered;
  }

  push(chunk: string): Key[] {
    this.buffered += chunk;
    const keys: Key[] = [];

    for (;;) {
      const step = this.step();
      if (step === null) break;
      this.buffered = this.buffered.slice(step.length);
      if (step.key !== null) keys.push(step.key);
    }

    return keys;
  }

  /** Abandon a partial sequence and report it verbatim. */
  flush(): Key[] {
    if (this.buffered.length === 0) return [];
    const raw = this.buffered;
    this.buffered = "";
    return [{ type: "unknown", raw }];
  }

  private step(): Step | null {
    const input = this.buffered;
    if (input.length === 0) return null;

    if (input[0] === "\u001b") return this.escape();

    const code = input.codePointAt(0) ?? 0;
    const ch = String.fromCodePoint(code);

    if (ch === "\r" || ch === "\n") return { key: { type: "enter" }, length: 1 };
    if (ch === "\u007f" || ch === "\b") return { key: { type: "backspace" }, length: 1 };
    if (ch === "\t") return { key: { type: "tab" }, length: 1 };

    const control = CONTROL_KEYS[code];
    if (control !== undefined) return { key: { type: "ctrl", value: control }, length: 1 };
    if (code < 0x20) return { key: null, length: 1 };

    return { key: { type: "char", value: ch }, length: ch.length };
  }

  private escape(): Step | null {
    const input = this.buffered;
    if (input.length === 1) return null; // could still be the start of a sequence

    if (input[1] !== "[") {
      // Alt+key, or a lone ESC that was followed by typing. Report and move on.
      return { key: { type: "unknown", raw: input.slice(0, 2) }, length: 2 };
    }

    const match = /^\[([0-9;]*)([~A-Za-z])/.exec(input.slice(1));
    if (match === null) {
      // Incomplete — wait, unless this is clearly garbage.
      return input.length < 8 ? null : { key: null, length: 2 };
    }

    const params = match[1] ?? "";
    const final = match[2] ?? "";
    const length = 1 + match[0].length;

    // Bracketed paste: ESC [ 200 ~ <text> ESC [ 201 ~
    if (params === "200" && final === "~") {
      const end = input.indexOf("\u001b[201~", 1);
      if (end === -1) return null; // wait for the closing marker
      return { key: { type: "paste", value: input.slice(length, end) }, length: end + 6 };
    }
    if (params === "201" && final === "~") return { key: null, length };

    if (final === "~") {
      const type = CSI_TILDE[params];
      return { key: type === undefined ? null : { type }, length };
    }

    const arrow = CSI_FINAL[final];
    if (arrow !== undefined) return { key: { type: arrow }, length };

    return { key: null, length };
  }
}
