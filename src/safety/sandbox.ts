// Containment — what the operating system will do that our own checks cannot.
//
// The trust layer decides whether a call should happen. The judge decides whether the
// result was acceptable. Neither one stops a command that has already been approved from
// writing somewhere it should not, and this module is honest that they cannot: an
// approval is a decision, not a fence.
//
// WHY THIS IS SHAPED AROUND DETECTION RATHER THAN A FIXED DESIGN
//
// There is no single sandbox available across our targets, and pretending otherwise is
// how products end up claiming containment they do not have:
//
//   · **Linux** — Landlock. Unprivileged, no configuration, one-way (rights can only be
//     removed), inherited by children, ephemeral by design. The best mechanism on any
//     platform, and it needs no root and no dependency.
//   · **macOS** — Seatbelt via `sandbox-exec`. Effective today, but `sandbox-exec` is a
//     deprecated, unsupported interface, and Apple's own containerization work is asking
//     for a replacement (apple/containerization#737, open since May 2026). Shipping it is
//     reasonable; *depending* on it is not.
//   · **Windows** — no unprivileged equivalent. WSL is a genuine option where installed,
//     since it gives a real Linux kernel with Landlock inside, but it changes command
//     semantics and is not available everywhere.
//   · **Play Store Android** — prohibited outright. Google's policy forbids autonomous
//     Accessibility API use, so a Play-distributed agent cannot contain itself this way at
//     all. Sideloaded Android via Shizuku is a different product with a different story.
//
// SO: the module detects, plans, and above all **discloses**. When nothing can contain a
// command, the caller is told — not so it can proceed quietly, but so it can do the one
// thing that still helps: tell the human, and lean on checkpoints as the recovery layer.
// That pairing is the point. Containment narrows what can happen; a checkpoint narrows
// what persists. When the first is unavailable, the second must be visible, not absent.
import { access, constants } from "node:fs/promises";
import { platform } from "node:os";

export type Backend = "landlock" | "seatbelt" | "wsl" | "none";

/** What a backend is actually able to restrain. Never inferred from its name. */
export type Containment = "fs-write" | "network" | "process";

export interface Capability {
  backend: Backend;
  contains: Containment[];
  /** Present when the backend is unavailable, saying why in one line. */
  reason?: string;
  /** Risks the user is entitled to know about, even when the backend works. */
  advisories: string[];
}

export interface SandboxPlan {
  backend: Backend;
  /** The wrapped command, or null when nothing can contain it. */
  command: string[];
  /**
   * Shell-level prefix for tools that take a command *string* rather than an argv.
   *
   * Only Seatbelt fills this, and that is a deliberate limitation rather than an
   * oversight: `sandbox-exec -p <profile> <command>` composes safely as a string because
   * the profile is a single quoted argument. WSL needs the whole command to become one
   * quoted argument to `sh -c`, and Landlock is applied in-process before exec — neither
   * survives being flattened into a shell string without reintroducing the very parsing
   * gap that CVE-2026-87987 exploited. So those stay argv-only, and a tool that can only
   * accept a string gets no containment from them rather than unsafe containment.
   */
  prefix: string | null;
  contains: Containment[];
  /**
   * What this plan does NOT stop. Always populated, because a plan that lists its
   * protections and omits its gaps is the kind of document that gets someone breached.
   */
  gaps: string[];
  /** The sentence the agent should say out loud when containment is absent. */
  disclosure: string | null;
}

/** The paths a workspace-write containment should allow. */
export interface PlanRequest {
  /** Absolute workspace root — the only place writes are permitted. */
  workspace: string;
  /** The command to run, as an argv array. */
  argv: string[];
  /** Whether the command needs the network. Default false, because default-off is the point. */
  network?: boolean;
}

/**
 * Seatbelt profile for macOS.
 *
 * Deny-by-default with explicit allow-back, scoped to the workspace and the standard
 * read-only system locations. Kept deliberately small: a profile nobody has read is a
 * profile nobody can defend, and every allowance here is one an attacker gets too.
 */
export function seatbeltProfile(workspace: string, network: boolean): string {
  const allow = [
    `    (literal "${workspace}")`,
    `    (literal "/usr/lib")`,
    `    (literal "/System/Library")`,
    `    (literal "/Library/Fonts")`,
    `    (literal "/private/var/db")`,
    `    (literal "/private/tmp")`,
  ].join("\n");

  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
${allow}
)
${network ? "" : "(deny network*)"}
(allow process-exec (literal "/usr/bin/env"))
`;
}

function canExecute(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/**
 * Work out what can actually contain a command on this machine.
 *
 * Deliberately conservative and deliberately *observable*. An unavailable backend is not
 * an error — it is the normal case on Windows and in CI — but it is never silent, because
 * silence here is how a product ends up believed to be sandboxed when it is not.
 */
export async function detect(workspace: string): Promise<Capability> {
  const os = platform();

  if (os === "linux") {
    // Node exposes the Landlock syscalls only when the build and kernel both support
    // them. Detecting the function rather than the platform is the difference between
    // "this is Linux" and "this can actually do it".
    const proc = process as unknown as Record<string, unknown>;
    if (typeof proc.landlockRestrictSelf === "function" && typeof proc.landlockCreateRuleset === "function") {
      return {
        backend: "landlock",
        contains: ["fs-write", "process"],
        advisories: [
          "Landlock is one-way: rules cannot be relaxed after the process starts, so a command that needs more access fails rather than escalating.",
          "Landlock constrains filesystem and, where the kernel supports it, network access. It does not constrain which process runs.",
        ],
      };
    }
    return {
      backend: "none",
      contains: [],
      reason: "this Node build does not expose the Landlock syscalls (needs a recent Node on a Landlock-enabled kernel)",
      advisories: [],
    };
  }

  if (os === "darwin") {
    if (await canExecute("/usr/bin/sandbox-exec")) {
      return {
        backend: "seatbelt",
        contains: ["fs-write", "process"],
        advisories: [
          "sandbox-exec is a deprecated, unsupported Apple interface with no replacement shipping; it works today and may not in a future macOS.",
          "Apple's own containerization project is asking for a successor (apple/containerization#737, open since May 2026), so treat this as a bridge.",
        ],
      };
    }
    return { backend: "none", contains: [], reason: "sandbox-exec is not present", advisories: [] };
  }

  if (os === "win32") {
    // WSL is a real containment option where installed — it supplies a Linux kernel with
    // Landlock — but it changes command semantics, so it is only offered, never assumed.
    if (await canExecute("C:\\Windows\\System32\\wsl.exe")) {
      return {
        backend: "wsl",
        contains: ["fs-write", "network", "process"],
        reason: undefined,
        advisories: [
          "Commands run inside WSL see a Linux filesystem, so Windows paths are translated and anything outside the mounted drives is invisible to them.",
          "WSL is a compatibility environment, not a security boundary Microsoft documents as one. Treat this as better than nothing, not as a guarantee.",
        ],
      };
    }
    return {
      backend: "none",
      contains: [],
      reason: "Windows has no unprivileged sandbox equivalent, and WSL is not installed",
      advisories: [],
    };
  }

  return { backend: "none", contains: [], reason: `no sandbox backend for ${os}`, advisories: [] };
}

/**
 * The sentence an uncontained command is worth.
 *
 * Not a warning banner that scrolls past — a statement of what is and is not protected,
 * in the language of the thing the user is about to lose. It is written to be read once
 * and understood, because the failure mode of a warning is not that it is ignored, it is
 * that it is *unparseable*.
 */
export function disclosureText(capability: Capability): string {
  switch (capability.backend) {
    case "landlock":
    case "seatbelt":
    case "wsl":
      return `This command will run under ${capability.backend} containment. ${capability.advisories.join(" ")}`;
    default:
      return (
        "No operating-system sandbox is available on this machine, so this command runs with " +
        "the same access you have. Weaver will still checkpoint your files first, so the change " +
        `can be undone — but nothing is stopping it in the first place. ${capability.reason ?? ""}`.trim()
      );
  }
}

/**
 * Build the concrete command for a call, given what this machine can do.
 *
 * The returned plan is always explicit about its gaps. `none` is a real answer and not an
 * error: it means the caller should reach for checkpoints and say so, rather than quietly
 * running the command as though it had been fenced.
 */
export async function plan(request: PlanRequest, capability: Capability): Promise<SandboxPlan> {
  const { argv } = request;
  const wantsNetwork = request.network === true;

  switch (capability.backend) {
    case "seatbelt": {
      const profile = seatbeltProfile(request.workspace, wantsNetwork);
      return {
        backend: "seatbelt",
        command: ["/usr/bin/sandbox-exec", "-p", profile, ...argv],
        // Single-quoted, and correctly so for /bin/sh: the profile has no single quotes
        // in it (only double-quoted literals), so this cannot be broken out of.
        prefix: `/usr/bin/sandbox-exec -p '${profile}' `,
        contains: capability.contains,
        gaps: [
          "Seatbelt constrains this process, not the agent that chose the command — a command that was going to do harm is only as safe as the decision to run it.",
          "Deprecated interface; may stop working in a future macOS without notice.",
        ],
        disclosure: null,
      };
    }
    case "landlock": {
      // Landlock applies to the calling process and is inherited by children, so the
      // wrapper is the command itself: the agent process restricts itself before exec.
      return {
        backend: "landlock",
        command: argv,
        // null: Landlock is applied in-process before exec, not by composing strings.
        prefix: null,
        contains: capability.contains,
        gaps: [
          "Landlock is applied in-process and inherited, so every child is covered — but the restriction is one-way and cannot be relaxed, meaning a command needing more access fails rather than escalating.",
          "Filesystem and network only. Nothing here constrains which binary runs or what it does with data it has already read.",
        ],
        disclosure: null,
      };
    }
    case "wsl": {
      // Escape for the shell that will parse this inside WSL, then translate the workspace
      // into its WSL path so containment is scoped to the same place the agent works. The
      // drive letter is lowercased because WSL mounts are `/mnt/c`, not `/mnt/C` — getting
      // that wrong makes `--cd` fail and the command run somewhere unintended.
      const escaped = argv.map((part) => part.replace(/(["\\$`])/g, "\\$1"));
      const wslWorkspace = request.workspace.replace(/^([A-Za-z]):\\/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
      return {
        backend: "wsl",
        command: ["wsl.exe", "--cd", wslWorkspace, "--", "sh", "-c", escaped.join(" ")],
        // null: flattening this into a command *string* would mean passing it through
        // cmd.exe's parser on Windows (%VAR%, ^, quotes) before it ever reaches `sh -c`.
        // Two nested parsers between intent and execution is precisely the gap
        // CVE-2026-87987 was, so a string-only caller gets no containment instead.
        prefix: null,
        contains: capability.contains,
        gaps: [
          "Runs in a Linux environment, so Windows-only commands will not behave as written.",
          "WSL is a compatibility layer, not a documented security boundary.",
        ],
        disclosure: null,
      };
    }
    default:
      return {
        backend: "none",
        command: argv,
        prefix: null,
        contains: [],
        gaps: [
          "No operating-system containment at all: this command can read, write and send anything your user account can.",
          "The only remaining control is the trust layer's consent prompt and the checkpoint taken before the call.",
        ],
        disclosure: disclosureText(capability),
      };
  }
}

/**
 * Whether a plan is strong enough to run without telling the human first.
 *
 * Deliberately narrow. Containment being present does not make a command safe, and the
 * trust layer is the thing that decides that — this only answers "must we additionally
 * disclose the absence of a fence", which is a different question and should stay one.
 */
export function needsDisclosure(capability: Capability): boolean {
  return capability.backend === "none";
}
