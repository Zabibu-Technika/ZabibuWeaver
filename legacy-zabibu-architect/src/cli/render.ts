// Terminal rendering. Amber is Canary's brand accent; Weaver wears the same
// colour, because they are the same family.
import { reportOrigin, type CanaryReport } from "../integrate/canary.ts";
import type { AgentEvent } from "../core/agent.ts";

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: string, text: string): string {
  return useColor ? `${code}${text}\u001b[0m` : text;
}

export const C = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
  amber: "\u001b[38;2;245;183;63m",
};

function sevColor(severity: string): string {
  if (severity === "critical") return C.red;
  if (severity === "high") return C.yellow;
  return C.gray;
}

export function banner(lines: string[]): void {
  console.log("");
  console.log(`${paint(C.bold + C.amber, "[ weaver ]")} a Zabibu Technika product`);
  console.log(`${paint(C.gray, "Weaver builds the nest. Canary guards the mine.")}`);
  console.log("");
  for (const line of lines) console.log(`${paint(C.gray, "  " + line)}`);
  console.log("");
}

export function promptLine(): string {
  return paint(C.cyan + C.bold, "you") + paint(C.gray, " ▸ ");
}

export function assistantStart(): void {
  process.stdout.write(paint(C.amber + C.bold, "weaver") + paint(C.gray, " ▸ "));
}

export function write(text: string): void {
  process.stdout.write(text);
}

export function assistantEnd(): void {
  process.stdout.write("\n");
}

export function notice(text: string): void {
  console.log(paint(C.gray, `  · ${text}`));
}

export function warn(text: string): void {
  console.log(paint(C.yellow, `  ! ${text}`));
}

export function error(text: string): void {
  console.log(paint(C.red, `  ✕ ${text}`));
}

export function toolCall(name: string, summary: string): void {
  const line = `  ${name}  ${summary}`;
  console.log(paint(C.dim, line));
}

export function toolResult(ok: boolean, output: string, ms: number): void {
  const first = output.split("\n").slice(0, 6).join("\n    ");
  const more = output.split("\n").length > 6 ? `\n    … ${output.split("\n").length - 6} more line(s)` : "";
  const mark = ok ? paint(C.green, "✓") : paint(C.red, "✕");
  console.log(`${mark} ${paint(C.gray, `${ms}ms`)} ${paint(C.gray, `${first}${more}`)}`);
}

export function canaryReport(report: CanaryReport): void {
  const origin = reportOrigin(report);
  const head = `${paint(C.bold + C.amber, "[ canary ]")} ${paint(C.gray, origin)}`;
  console.log("");
  console.log(head);

  if (report.judgeError !== undefined) {
    console.log(paint(C.red + C.bold, "  SIGN-OFF FAILED — this change was never judged, so it is BLOCKED."));
    console.log(paint(C.gray, `  ${report.judgeError}`));
    console.log(
      paint(C.gray, "  An unjudged change is not a clean one. Fix the judge and re-run."),
    );
    return;
  }

  console.log(
    paint(
      C.gray,
      `  risk ${report.riskScore}/100 · grade ${report.grade} · ${report.verdict}` +
        ` (${report.filesChanged} file(s), +${report.insertions} / -${report.deletions})`,
    ),
  );

  for (const finding of report.findings) {
    console.log(`${paint(sevColor(finding.severity), `  [${finding.severity}]`)} ${finding.title}`);
    if (finding.filePath !== undefined) console.log(paint(C.gray, `    file: ${finding.filePath}`));
  }

  if (report.findings.length === 0) {
    console.log(paint(C.green, "  no findings — the change looks safe."));
  }

  if (report.approved) {
    console.log(paint(C.green, "  signed off in the approval ledger."));
  } else if (report.blocked) {
    console.log(paint(C.red + C.bold, "  BLOCKED — critical findings without a signed approval."));
    // No bypass is offered here, and that is the whole point. Weaver embeds the
    // judge, not the pen: it cannot approve its own work, so the only routes out
    // are a real fix or a human signature in Canary.
    console.log(paint(C.gray, "  Weaver cannot sign this itself. Clear the findings and re-run, or have a human"));
    console.log(paint(C.gray, "  sign the receipt in Canary (`zabibucanary review`)."));
  }

  if (report.untracked.length > 0) {
    const names = report.untracked.slice(0, 5).join(", ");
    const more = report.untracked.length > 5 ? ` +${report.untracked.length - 5} more` : "";
    console.log(
      paint(C.yellow, `  ${report.untracked.length} untracked file(s) not covered: ${names}${more}`),
    );
    console.log(paint(C.gray, "  git diff cannot see new files — stage them to bring them into the sign-off."));
  }
  console.log("");
}

/** Turn agent events into terminal output. */
export function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "delta":
      write(event.text);
      break;
    case "assistant":
      assistantEnd();
      break;
    case "tool-call":
      toolCall(event.name, JSON.stringify(event.args).slice(0, 140));
      break;
    case "tool-result":
      toolResult(event.ok, event.output, event.ms);
      break;
    case "tool-denied":
      warn(`${event.name} denied — ${event.reason}`);
      break;
    case "notice":
      notice(event.text);
      break;
    case "canary":
      canaryReport(event.report);
      break;
    case "error":
      error(event.message);
      break;
    case "turn-end":
      break;
  }
}
