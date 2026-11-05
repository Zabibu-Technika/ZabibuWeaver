// Proof receipts — the evidence a turn leaves behind.
//
// Every agent says "done". Almost none can show what that claim rests on. A terminal
// transcript scrolls away, and a chat log is a record of assertions, not of checks. This
// module writes a small, durable artifact: which commands ran, what they exited with, and
// — the part everyone omits — whether the agent authored the checks that judged it.
//
// THE SELF-AUTHORED PROBLEM
//
// Running `npm test` is only evidence if the tests are independent of the change. An
// agent that writes a test asserting nothing, then reports a green run, has produced a
// confidence trick with extra steps. So a receipt records every file the turn touched,
// and if any of them is a test, a test config, or a check command, the status is capped
// at `partial`. Not because the work is wrong — because the proof is not independent.
//
// WHAT IS NOT STORED
//
// Output digests, not output. A failing test can print a token, a connection string, or a
// customer record, and a receipt directory is exactly the kind of local artefact people
// later zip and send to someone. The digest binds the receipt to the output without
// copying the output into a second place that has to be secured.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { VerificationReport } from "./index.ts";

export type ProofStatus =
  /** Every detected check passed, and none of them was authored by this turn. */
  | "proved"
  /** Something passed, but the proof is incomplete or not independent. */
  | "partial"
  /** Nothing was checked. This is not a pass. */
  | "unproven"
  /** A check ran and failed. */
  | "failed";

export interface ProofCheck {
  name: string;
  command: string;
  ok: boolean;
  code: number | null;
  ms: number;
  timedOut: boolean;
  /** sha256 of the output. Proof that it ran, without copying the output. */
  outputDigest: string;
  /** Size of the output, for the "was this even a real run" question. */
  outputBytes: number;
}

export interface ProofReceipt {
  id: string;
  at: string;
  workspace: string;
  status: ProofStatus;
  checks: ProofCheck[];
  skipped: Array<{ name: string; reason: string }>;
  /**
   * True when the turn changed something that decides whether the checks pass: a test
   * file, a test config, or the command itself. Independent proof requires not touching
   * the judge.
   */
  selfAuthored: boolean;
  /** Every path the turn wrote or edited. */
  touched: string[];
  /** Canary's analysis id, when a judge ran on the diff. */
  analysisId?: string;
  notes: string[];
}

/** A test file, a test directory, or a file that configures the checks. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR = /(^|\/)(__tests__|tests?|specs?)\//i;
const CHECK_CONFIG =
  /(^|\/)(package\.json|pytest\.ini|conftest\.py|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|tsconfig\.json|Cargo\.toml|go\.mod)$/i;

export function isTestPath(path: string): boolean {
  const normalised = path.split("\\").join("/");
  return TEST_FILE.test(normalised) || TEST_DIR.test(normalised) || CHECK_CONFIG.test(normalised);
}

/**
 * The honest label for a turn.
 *
 * Ordered by what a reader needs to know first: did anything fail, did anything run,
 * can the result be trusted as independent.
 */
export function statusFor(report: VerificationReport | null, options: { selfAuthored: boolean }): ProofStatus {
  if (report === null || report.checks.length === 0) return "unproven";
  if (report.checks.some((check) => !check.ok)) return "failed";
  if (options.selfAuthored) return "partial";
  if (report.skipped.length > 0) return "partial";
  return "proved";
}

export interface ProofInput {
  workspace: string;
  report: VerificationReport | null;
  touched: string[];
  analysisId?: string;
  at?: Date;
}

export interface ProofWritten {
  receipt: ProofReceipt;
  jsonPath: string;
  markdownPath: string;
}

function receiptId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "").replace("Z", "");
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

export function receiptMarkdown(receipt: ProofReceipt): string {
  const lines: string[] = [
    `# Proof receipt — ${receipt.status}`,
    "",
    `- at: ${receipt.at}`,
    `- workspace: ${receipt.workspace}`,
    `- canary analysis: ${receipt.analysisId ?? "not run"}`,
    `- self-authored checks: ${receipt.selfAuthored ? "yes — the proof is not independent" : "no"}`,
    "",
    "## Checks",
    "",
  ];

  if (receipt.checks.length === 0) {
    lines.push("_No checks ran._");
  } else {
    lines.push("| check | result | exit | time | output |", "| --- | --- | ---: | ---: | --- |");
    for (const check of receipt.checks) {
      const result = check.timedOut ? "TIMEOUT" : check.ok ? "PASS" : "FAIL";
      lines.push(
        `| ${check.name} | ${result} | ${check.code ?? "—"} | ${check.ms}ms | ${check.outputBytes} bytes, sha256:${check.outputDigest.slice(0, 12)} |`,
      );
    }
  }

  if (receipt.skipped.length > 0) {
    lines.push("", "## Not run", "");
    for (const skip of receipt.skipped) lines.push(`- ${skip.name} — ${skip.reason}`);
  }

  if (receipt.touched.length > 0) {
    lines.push("", "## Files this turn touched", "");
    for (const path of receipt.touched) lines.push(`- ${path}`);
  }

  if (receipt.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of receipt.notes) lines.push(`- ${note}`);
  }

  lines.push(
    "",
    "_Output is not stored. The digest binds this receipt to what was printed; re-run the_",
    "_command to read it again._",
    "",
  );
  return lines.join("\n");
}

export function receiptsDir(workspace: string): string {
  return join(resolve(workspace), ".weaver", "receipts");
}

/** Write the receipt. Returns the paths so the UI can point at something concrete. */
export async function writeReceipt(input: ProofInput): Promise<ProofWritten> {
  const now = input.at ?? new Date();
  const selfAuthored = input.touched.some(isTestPath);
  const status = statusFor(input.report, { selfAuthored });

  const receipt: ProofReceipt = {
    id: receiptId(now),
    at: now.toISOString(),
    workspace: resolve(input.workspace),
    status,
    checks: (input.report?.checks ?? []).map((check) => ({
      name: check.name,
      command: check.command,
      ok: check.ok,
      code: check.code,
      ms: check.ms,
      timedOut: check.timedOut,
      outputDigest: createHash("sha256").update(check.output).digest("hex"),
      outputBytes: Buffer.byteLength(check.output, "utf8"),
    })),
    skipped: input.report?.skipped ?? [],
    selfAuthored,
    touched: [...new Set(input.touched)],
    notes: [],
  };
  if (input.analysisId !== undefined) receipt.analysisId = input.analysisId;

  if (status === "unproven") {
    receipt.notes.push("No verification checks were detected, so nothing was proven either way.");
  }
  if (selfAuthored) {
    receipt.notes.push(
      "This turn changed a test, a test config, or a check command. A passing run is not independent evidence.",
    );
  }
  if (receipt.checks.length > 0 && receipt.skipped.length > 0) {
    receipt.notes.push("Some checks were not run; see the list above.");
  }

  const directory = receiptsDir(input.workspace);
  await mkdir(directory, { recursive: true });
  const jsonPath = join(directory, `${receipt.id}.json`);
  const markdownPath = join(directory, `${receipt.id}.md`);
  await writeFile(jsonPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, receiptMarkdown(receipt), "utf8");
  return { receipt, jsonPath, markdownPath };
}

/**
 * Recent receipts, newest first.
 *
 * A corrupt receipt is skipped rather than failing the listing: a receipt is evidence,
 * and one damaged file must not hide the others.
 */
export async function listReceipts(workspace: string): Promise<ProofReceipt[]> {
  let names: string[];
  try {
    names = await readdir(receiptsDir(workspace));
  } catch {
    return [];
  }

  const receipts: ProofReceipt[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(receiptsDir(workspace), name), "utf8")) as ProofReceipt;
      if (typeof parsed.id === "string" && typeof parsed.status === "string") receipts.push(parsed);
    } catch {
      // Skip the damaged file; keep the evidence that survives.
    }
  }
  return receipts.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** One line for the end of a turn, or for `weaver receipts`. */
export function summarizeProof(receipt: ProofReceipt): string {
  const passed = receipt.checks.filter((check) => check.ok).length;
  const total = receipt.checks.length;
  const head =
    receipt.status === "proved"
      ? `proved — ${passed}/${total} check(s) passed`
      : receipt.status === "failed"
        ? `not proved — ${total - passed}/${total} check(s) failed`
        : receipt.status === "partial"
          ? `partially proved — ${passed}/${total} check(s) passed`
          : "unproven — no checks ran";
  const caveat = receipt.selfAuthored ? " · this turn changed the checks themselves" : "";
  return `${head}${caveat}`;
}
