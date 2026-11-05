// Pure diff-analysis engine. No I/O, no framework imports — unit-testable with node:test.
// Detector taxonomy follows the Mega rules: Module 1 (correctness first),
// Module 6 (secrets/authorization), Module 7 (supply chain).

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  filePath?: string;
}

export interface AnalysisResult {
  riskScore: number;
  grade: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  findings: Finding[];
}

interface FileDiff {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  insertions: number;
  deletions: number;
  addedLines: string[];
}

const WEIGHTS: Record<Severity, number> = { critical: 34, high: 17, medium: 8, low: 3, info: 0 };
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

// Keyword may be wrapped by prefixes/suffixes: STRIPE_SECRET_KEY, my_api_key, etc.
const SECRET_HEAD = "[A-Za-z0-9_]*(?:secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*";

const SECRET_PATTERNS: RegExp[] = [
  new RegExp(`${SECRET_HEAD}\\s*[:=]\\s*["'][^"'\\s]{8,}["']`, "i"),
  new RegExp(`${SECRET_HEAD}\\s*[:=]\\s*[A-Za-z0-9_\\-]{16,}\\s*$`, "i"),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

// Redaction for anything we persist or encode into a URL.
//
// Analysis always sees the original text; this runs on the copy we store and put
// into report links. It keeps the key name so the rendered diff still reads like
// code, and hides only the value.
//
// Read the limit honestly: it covers the shapes above and nothing else. A secret
// the detector does not recognise was never matched, so it is not redacted. This
// is a safety net, not a guarantee, and the docs say exactly that.
export const REDACTED = "[redacted]";

function redactMatch(match: string): string {
  const assignment = match.match(/^([A-Za-z0-9_]+\s*[:=]\s*)([\s\S]*)$/);
  return assignment ? `${assignment[1]}${REDACTED}` : REDACTED;
}

export function redactSecrets(content: string): string {
  let out = content;
  for (const pattern of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`);
    out = out.replace(global, redactMatch);
  }
  return out;
}

// Plain-text mode detectors — patterns that matter to non-developers pasting
// raw AI output (ChatGPT/Claude code blocks, notes, anything).
const DANGER_PATTERNS: { pattern: RegExp; severity: Severity; category: string; title: string; detail: string }[] = [
  {
    pattern: /\beval\s*\(/,
    severity: "high",
    category: "dangerous-code",
    title: "Code that runs text as commands",
    detail:
      "This uses eval() — it runs whatever text it is given as real code. If any attacker can influence that text, they control the program.",
  },
  {
    pattern: /(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*["']\s*\+/i,
    severity: "high",
    category: "injection",
    title: "Database command built by gluing text together",
    detail:
      "This builds a database command by joining pieces of text. That is the classic opening for SQL injection — an attacker can add their own commands to it.",
  },
  {
    pattern: /\b(child_process|execSync|exec)\s*\(/,
    severity: "medium",
    category: "dangerous-code",
    title: "Runs other programs from the code",
    detail:
      "This hands work to the operating system to run another program. If any of the text comes from a user, they may be able to run their own commands.",
  },
  {
    pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/i,
    severity: "low",
    category: "insecure-transport",
    title: "A web link without encryption",
    detail: "This link uses http:// instead of https://. Anything sent over it can be read or changed while it travels.",
  },
];

const SCHEMA_PATTERNS = [/(^|\/)schema\.prisma$/, /(^|\/)migrations?\//i, /\.sql$/i, /(^|\/)schema\.ts$/];
const AUTH_PATTERNS = [/(^|\/)(auth|login|session|permission|rbac|guard)\//i, /(^|\/)middleware\.[tj]sx?$/];
const ENV_PATTERNS = [/(^|\/)\.env(\..+)?$/];
const INFRA_PATTERNS = [/Dockerfile/i, /docker-compose/i, /\.github\/workflows\//, /\.gitlab-ci/, /vercel\.json$/];
const LOCKFILES = [/package-lock\.json$/, /pnpm-lock\.yaml$/, /yarn\.lock$/, /Cargo\.lock$/, /poetry\.lock$/];
const MANIFESTS = [/package\.json$/, /Cargo\.toml$/, /requirements.*\.txt$/, /go\.mod$/];
const TEST_PATTERNS = [/\.(test|spec)\.[tj]sx?$/, /(^|\/)__tests__\//, /(^|\/)tests?\//i];

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const rawLine of diff.split(/\r?\n/)) {
    const header = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = { path: header[2], isNew: false, isDeleted: false, insertions: 0, deletions: 0, addedLines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("new file mode")) current.isNew = true;
    else if (rawLine.startsWith("deleted file mode")) current.isDeleted = true;
    else if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      current.insertions += 1;
      current.addedLines.push(rawLine.slice(1));
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      current.deletions += 1;
    }
  }
  return files;
}

function detect(files: FileDiff[]): Finding[] {
  const findings: Finding[] = [];

  for (const f of files) {
    if (ENV_PATTERNS.some((p) => p.test(f.path))) {
      findings.push({
        severity: "critical",
        category: "secrets",
        title: "Environment file present in diff",
        detail:
          "A .env file is being committed. Environment files must live in .gitignore; import values from environment variables or a secret manager instead.",
        filePath: f.path,
      });
    }

    const secretLine = f.addedLines.find((line) => SECRET_PATTERNS.some((p) => p.test(line)));
    if (secretLine) {
      findings.push({
        severity: "critical",
        category: "secrets",
        title: "Possible hardcoded secret in added lines",
        detail:
          "An added line matches a credential shape (key/token/password or private key block). Move it to an environment variable or secret manager and rotate the exposed value.",
        filePath: f.path,
      });
    }

    if (SCHEMA_PATTERNS.some((p) => p.test(f.path))) {
      findings.push({
        severity: "high",
        category: "schema",
        title: "Database schema or migration change",
        detail:
          "Schema changes alter every downstream consumer. Verify migrations are reversible, tenant-scoped, and shipped with the code that needs them.",
        filePath: f.path,
      });
    }

    if (AUTH_PATTERNS.some((p) => p.test(f.path))) {
      findings.push({
        severity: "high",
        category: "authorization",
        title: "Authentication / authorization surface touched",
        detail:
          "Changes to auth, session, permission, or middleware code expand the attack surface. Confirm token verification, RBAC checks, and tenant isolation are intact (STRIDE spoofing / elevation of privilege).",
        filePath: f.path,
      });
    }

    if (MANIFESTS.some((p) => p.test(f.path))) {
      findings.push({
        severity: "medium",
        category: "supply-chain",
        title: "Dependency manifest changed",
        detail: "New or updated dependencies enter the supply chain. Verify each addition is necessary, maintained, and audited.",
        filePath: f.path,
      });
      const unpinned = f.addedLines.some((line) => /"[\w@./-]+"\s*:\s*"[\^~*]/.test(line));
      if (unpinned) {
        findings.push({
          severity: "medium",
          category: "supply-chain",
          title: "Unpinned dependency version",
          detail:
            "A dependency was added with a range specifier (^, ~, or *). Production dependencies must be pinned to exact versions with lockfile hashes.",
          filePath: f.path,
        });
      }
    }

    if (LOCKFILES.some((p) => p.test(f.path))) {
      findings.push({
        severity: "low",
        category: "supply-chain",
        title: "Lockfile churn",
        detail: "Lockfile changes accompany dependency drift. Confirm the diff only reflects intended manifest changes.",
        filePath: f.path,
      });
    }

    if (INFRA_PATTERNS.some((p) => p.test(f.path))) {
      findings.push({
        severity: "medium",
        category: "infrastructure",
        title: "Infrastructure or CI configuration touched",
        detail: "Infrastructure changes affect deployment and runtime guarantees. Review build, runtime user, and secret exposure.",
        filePath: f.path,
      });
    }

    if (TEST_PATTERNS.some((p) => p.test(f.path))) {
      findings.push({
        severity: "info",
        category: "tests",
        title: "Tests updated alongside change",
        detail: "Test coverage changes in the same diff — a good signal, slightly reducing overall risk.",
        filePath: f.path,
      });
    }

    for (const a of A11Y_PATTERNS) {
      if (f.addedLines.some((line) => a.pattern.test(line))) {
        findings.push({
          severity: a.severity,
          category: "accessibility",
          title: a.title,
          detail: a.detail,
          filePath: f.path,
        });
        break;
      }
    }
  }

  const net = files.reduce((sum, f) => sum + f.insertions - f.deletions, 0);
  if (files.length > 25 || net > 500) {
    findings.push({
      severity: "medium",
      category: "scope",
      title: "Large blast radius",
      detail: `This diff spans ${files.length} file(s) with ${net > 0 ? "+" : ""}${net} net lines. Large diffs deserve extra review.`,
    });
  }

  return findings;
}

export function gradeFor(score: number): string {
  if (score < 15) return "A";
  if (score < 30) return "B";
  if (score < 50) return "C";
  if (score < 70) return "D";
  return "E";
}

// Accessibility detectors — the "can everyone still use it" sector.
const A11Y_PATTERNS: { pattern: RegExp; severity: Severity; title: string; detail: string }[] = [
  {
    pattern: /outline\s*:\s*(none|0)\b/i,
    severity: "medium",
    title: "Keyboard focus outline removed",
    detail:
      "This removes the visible focus ring, so people who navigate with a keyboard or a switch device cannot see where they are on the page.",
  },
  {
    pattern: /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0)?\b/i,
    severity: "medium",
    title: "Page zoom is blocked",
    detail:
      "This stops people from zooming in, which locks out users with low vision who need to enlarge text to read it.",
  },
  {
    pattern: /<div[^>]*\sonClick/i,
    severity: "medium",
    title: "Clickable element keyboards cannot reach",
    detail:
      "A plain div with a click handler cannot be reached with a keyboard or announced by a screen reader. Use a button, or add keyboard support.",
  },
];

// True when the input looks like a unified diff (git output); otherwise it is
// treated as freeform text pasted from an AI chat.
export function looksLikeDiff(input: string): boolean {
  return /(^|\n)diff --git /.test(input) || /(^|\n)@@ /.test(input);
}

export function analyzeText(text: string): AnalysisResult {
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = [];

  const add = (f: Finding) => {
    // One finding per category keeps the report calm and readable.
    if (!findings.some((existing) => existing.category === f.category)) findings.push(f);
  };

  for (const line of lines) {
    if (SECRET_PATTERNS.some((p) => p.test(line))) {
      add({
        severity: "critical",
        category: "secrets",
        title: "Possible hardcoded secret in pasted text",
        detail:
          "A line looks like a real password, key, or token typed directly into text. Treat it as exposed.",
      });
    }
    for (const d of DANGER_PATTERNS) {
      if (d.pattern.test(line)) {
        add({ severity: d.severity, category: d.category, title: d.title, detail: d.detail });
        break;
      }
    }
    for (const a of A11Y_PATTERNS) {
      if (a.pattern.test(line)) {
        add({ severity: a.severity, category: "accessibility", title: a.title, detail: a.detail });
        break;
      }
    }
  }

  const score = Math.max(
    0,
    Math.min(100, findings.reduce((sum, f) => sum + WEIGHTS[f.severity], 0)),
  );

  return {
    riskScore: score,
    grade: gradeFor(score),
    filesChanged: 0,
    insertions: lines.length,
    deletions: 0,
    findings: findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
  };
}

// Single entry point: routes pasted content to the diff parser or the text scanner.
export function analyzeContent(input: string): AnalysisResult {
  return looksLikeDiff(input) ? analyzeDiff(input) : analyzeText(input);
}

export function analyzeDiff(diff: string): AnalysisResult {
  const files = parseDiff(diff);
  const findings = detect(files).sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );

  let score = findings.reduce((sum, f) => sum + WEIGHTS[f.severity], 0);
  const testFiles = files.filter((f) => TEST_PATTERNS.some((p) => p.test(f.path))).length;
  score -= Math.min(testFiles * 3, 9);
  score = Math.max(0, Math.min(100, score));

  return {
    riskScore: score,
    grade: gradeFor(score),
    filesChanged: files.length,
    insertions: files.reduce((sum, f) => sum + f.insertions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    findings,
  };
}
