// The sign-off.
//
// After Weaver changes files, the judge analyses the diff and reports what it
// found. If it carries a critical finding and no signed approval exists in the
// ledger, the turn is marked blocked.
//
// The judge is the SAME engine that powers the Canary web app and CLI — vendored
// into `src/engine/` as a byte-for-byte, hash-pinned copy (see provenance.json
// and `npm run vendor:engine`). Embedding it means Weaver runs on its own: no
// sibling checkout to find, no second project to install, no CLI on PATH.
//
// It is still independent in the way that matters. Provenance pins the copy to an
// upstream commit, `provenance.test.ts` fails if the copy and that record ever
// disagree, and the engine is deterministic — no network, no model, no
// temperature. So the verdict is reproducible and the analysis id is the same one
// the Canary CLI would compute from the same diff.
//
// What is NOT here: Canary's signing half (`ledger.ts`). Weaver embeds the judge,
// not the pen. It can read the approval ledger and be blocked by it; it cannot
// generate a key or write a receipt. An agent that can sign its own permission
// slip is not being governed, it is being asked nicely.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnalysisResult, Finding, SectorImpact } from "../core/types.ts";
import type { WeaverConfig } from "../config.ts";

export interface CanaryReport {
  /** Where the verdict came from: the vendored engine, or a dev override. */
  source: "embedded" | "override";
  /** The upstream commit the embedded engine was vendored from, when known. */
  commit: string | null;
  analysisId: string;
  riskScore: number;
  grade: string;
  verdict: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  findings: Finding[];
  sectors: Record<string, SectorImpact>;
  approved: boolean;
  blocked: boolean;
  /**
   * Set when the JUDGE itself failed — it could not be loaded, or it threw while
   * analysing the diff. The change was therefore never judged, which is not the
   * same as being judged clean. Reports with this set are always `blocked`.
   */
  judgeError?: string;
  /** Untracked files that `git diff` cannot see, so the sign-off does not cover them. */
  untracked: string[];
}

/** The slice of the engine this file uses. */
interface Judge {
  analyzeContent(input: string): AnalysisResult;
  verdictFor(findings: Finding[]): { label: string };
  sectorImpacts(findings: Finding[]): Record<string, SectorImpact>;
}

interface Provenance {
  source: { repo: string | null; engineDir: string; commit: string | null; dirty: boolean | null };
  files: Record<string, { sha256: string; bytes: number }>;
}

const PROVENANCE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "engine", "provenance.json");

let provenanceCache: Provenance | null | undefined;

/** The record pinning the vendored engine to its upstream commit. */
export function engineProvenance(): Provenance | null {
  if (provenanceCache !== undefined) return provenanceCache;
  try {
    provenanceCache = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as Provenance;
  } catch {
    provenanceCache = null;
  }
  return provenanceCache;
}

/** A short label for the active judge, for honest startup messaging. */
export function engineLabel(cfg: WeaverConfig): string {
  if (cfg.canaryEngine !== null) return `override · ${cfg.canaryEngine}`;
  const commit = engineProvenance()?.source.commit ?? null;
  return commit === null ? "embedded" : `embedded · canary ${commit.slice(0, 8)}`;
}

function git(workspace: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      // Swallow git's chatter: a directory that is simply not a repo is not an error here.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export function inGitRepo(workspace: string): boolean {
  return git(workspace, ["rev-parse", "--is-inside-work-tree"]) !== null;
}

/** Match the Canary CLI: staged changes first, then the working tree. */
function collectDiff(workspace: string): string | null {
  const staged = git(workspace, ["diff", "--staged"]);
  if (staged !== null && staged.trim().length > 0) return staged;
  return git(workspace, ["diff"]);
}

/**
 * New files `git diff` cannot see. Weaver does not stage them — staging would
 * change the diff hash and break receipt matching with the Canary CLI, so the
 * honest move is to say what is not covered.
 */
function untrackedFiles(workspace: string): string[] {
  const status = git(workspace, ["status", "--porcelain"]);
  if (status === null) return [];
  return status
    .split(/\r?\n/)
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

/** Canary identifies a review by sha256(diff) truncated to 16 hex chars. */
export function analysisIdFor(diff: string): string {
  return createHash("sha256").update(diff).digest("hex").slice(0, 16);
}

function ledgerApproved(analysisId: string): boolean {
  const file = join(homedir(), ".zabibucanary", "ledger.jsonl");
  if (!existsSync(file)) return false;
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as { analysisId?: string };
      if (record.analysisId === analysisId) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** A short, honest label for where a verdict came from. */
export function reportOrigin(report: CanaryReport): string {
  if (report.source === "override") return "engine override";
  return report.commit === null
    ? "embedded engine"
    : `embedded engine · canary ${report.commit.slice(0, 8)}`;
}

function hasCritical(findings: Finding[]): boolean {
  return findings.some((finding) => finding.severity === "critical");
}

// A dev override, for A/B-ing the embedded engine against a working tree.
// Opt-in and explicit: the default is always the pinned copy, so a normal run is
// reproducible without anyone having to remember not to touch this.
// Keyed by path, because an override that fails for one path says nothing about
// the next one.
const overrideCache = new Map<string, Judge | null>();

async function loadOverride(path: string): Promise<Judge | null> {
  const cached = overrideCache.get(path);
  if (cached !== undefined) return cached;

  let loaded: Judge | null = null;
  if (existsSync(path)) {
    try {
      const mod = (await import(pathToFileURL(path).href)) as unknown as Partial<Judge>;
      loaded = typeof mod.analyzeContent === "function" ? (mod as Judge) : null;
    } catch {
      loaded = null;
    }
  }
  overrideCache.set(path, loaded);
  return loaded;
}

// The embedded engine is loaded through a COMPUTED specifier, never a static
// import. Both reasons matter:
//
//   1. Truth. `analyze.ts` is a byte-for-byte copy of code written and typechecked
//      under Canary's compiler options. Weaver turns on `noUncheckedIndexedAccess`,
//      which upstream does not, so a static import would report errors inside code
//      Weaver is forbidden to edit. A dependency pinned by hash must not also be
//      expected to satisfy the consumer's house style. The fix for a real type
//      error in the engine is upstream, then re-vendor — not a local patch.
//   2. Discipline. Keeping the boundary dynamic makes the engine a dependency in
//      fact as well as in name. `npm run typecheck:engine` checks it under its own
//      rules, and the provenance tests pin its bytes.
const ENGINE_URL = new URL("../engine/index.ts", import.meta.url).href;

let embeddedCache: Judge | null | undefined;

async function loadEmbedded(): Promise<Judge | null> {
  if (embeddedCache !== undefined) return embeddedCache;
  try {
    const mod = (await import(ENGINE_URL)) as unknown as Partial<Judge>;
    embeddedCache = typeof mod.analyzeContent === "function" ? (mod as Judge) : null;
  } catch {
    embeddedCache = null;
  }
  return embeddedCache;
}

type JudgeResolution =
  | { ok: true; judge: Judge; source: "embedded" | "override" }
  | { ok: false; error: string; source: "embedded" | "override" };

/**
 * Resolve the judge, or explain precisely why there isn't one.
 *
 * This returns a failure rather than throwing, because every failure mode here is
 * an expected one and each deserves to reach the user as a message: a broken
 * vendored copy, or an explicit override that points somewhere unusable. Falling
 * back to the embedded copy when a named override fails would be worse than
 * either — the user asked for a specific judge and silently getting a different
 * one is a lie about which rules ran.
 */
async function judgeFor(cfg: WeaverConfig): Promise<JudgeResolution> {
  if (cfg.canaryEngine !== null) {
    const override = await loadOverride(cfg.canaryEngine);
    if (override !== null) return { ok: true, judge: override, source: "override" };
    return {
      ok: false,
      source: "override",
      error:
        `WEAVER_CANARY_ENGINE points at ${cfg.canaryEngine}, which could not be loaded ` +
        `(missing, invalid, or it threw on import)`,
    };
  }

  const embedded = await loadEmbedded();
  if (embedded === null) {
    return {
      ok: false,
      source: "embedded",
      error: "the embedded canary engine could not be loaded — re-vendor it with `npm run vendor:engine`",
    };
  }
  return { ok: true, judge: embedded, source: "embedded" };
}

/**
 * Build a report for a change that could not be judged.
 *
 * Fail closed. Semgrep's rule: an internal error must never register as a clean
 * pass, because the alternative is a gate that silently stops working. So the
 * report is `blocked`, never `approved`, and carries the reason. The numbers are
 * placeholders — `judgeError` short-circuits every renderer before they are
 * shown, because a risk score that was never computed must not be displayed as
 * though it was.
 */
function judgeFailedReport(
  error: string,
  context: { analysisId: string; source: "embedded" | "override"; untracked: string[] },
): CanaryReport {
  return {
    source: context.source,
    commit: engineProvenance()?.source.commit ?? null,
    analysisId: context.analysisId,
    riskScore: 0,
    grade: "—",
    verdict: "sign-off failed — this change was never judged",
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    findings: [],
    sectors: {},
    approved: false,
    blocked: true,
    judgeError: error,
    untracked: context.untracked,
  };
}

/**
 * Review the workspace's current diff. Returns null when there is nothing to
 * review, Canary is off, or the workspace is not a git repository.
 */
export async function reviewWorkspace(cfg: WeaverConfig): Promise<CanaryReport | null> {
  if (cfg.canary === "off") return null;
  if (!inGitRepo(cfg.workspace)) return null;

  const diff = collectDiff(cfg.workspace);
  if (diff === null || diff.trim().length === 0) return null;

  const analysisId = analysisIdFor(diff);
  const approved = ledgerApproved(analysisId);
  const untracked = untrackedFiles(cfg.workspace);

  const resolution = await judgeFor(cfg);
  if (!resolution.ok) return judgeFailedReport(resolution.error, { analysisId, source: resolution.source, untracked });

  let result: AnalysisResult;
  let verdict: { label: string };
  let sectors: Record<string, SectorImpact>;
  try {
    const { judge } = resolution;
    result = judge.analyzeContent(diff);
    verdict = judge.verdictFor(result.findings);
    sectors = judge.sectorImpacts(result.findings);
  } catch (err) {
    return judgeFailedReport(
      `the judge threw while analysing this diff: ${err instanceof Error ? err.message : String(err)}`,
      { analysisId, source: resolution.source, untracked },
    );
  }

  return {
    source: resolution.source,
    commit: engineProvenance()?.source.commit ?? null,
    analysisId,
    riskScore: result.riskScore,
    grade: result.grade,
    verdict: verdict.label,
    filesChanged: result.filesChanged,
    insertions: result.insertions,
    deletions: result.deletions,
    findings: result.findings,
    sectors,
    approved,
    blocked: !approved && hasCritical(result.findings),
    untracked,
  };
}

/** True when a sign-off can actually run here. */
export function canaryAvailable(cfg: WeaverConfig): boolean {
  return cfg.canary !== "off" && inGitRepo(cfg.workspace);
}
