// User profiles — who is sitting in front of this, and how much they want in the way.
//
// The product goal is a range: from someone who has never opened a terminal to a
// "ponytail-style" developer who wants verification, conversation, and code correction
// with no ceremony. One dial, many positions.
//
// THE TRAP, and the reason this file is shaped the way it is:
//
// It would be easy — and wrong — to treat "security safeguards" as another knob on the
// same dial, so that an expert gets a looser gate. The Varonis phishing simulation in
// June 2026 tricked *the agent*, not a beginner: it leaked AWS keys and customer data
// because it granted access when a request felt urgent. The agent's operator's skill
// level was irrelevant. An expert's agent reading a poisoned web page is exactly as
// exploitable as a novice's.
//
// So the dial controls friction, exposure, and verbosity. It does not control whether
// the trust boundaries hold. Those are in INVARIANTS below, they are not part of any
// profile, and `profiles.test.ts` fails if anyone ever wires one up as a knob.
import type { Capability, PermissionMode } from "../core/types.ts";

export type ProfileId =
  /** Has never opened a terminal. Wants a thing to happen, not a tool to operate. */
  | "explorer"
  /** Comfortable with apps and phones. Not a developer. The common case. */
  | "general"
  /** Technical, not a coder. Sysadmin, analyst, power Office user. */
  | "power"
  /** Writes code. Wants the coding toolset and minimal ceremony. */
  | "developer"
  /** "Ponytail-style". High-end code, wants correction, conversation, verification. */
  | "expert";

/** The order matters: it is the axis the dial turns along. */
export const PROFILE_ORDER: ProfileId[] = ["explorer", "general", "power", "developer", "expert"];

export type Verbosity = "plain" | "brief" | "terse";

export interface Profile {
  id: ProfileId;
  label: string;
  /** One line, in the user's language, not ours. */
  blurb: string;
  /**
   * Default permission mode. `readonly` is never a default: a tool that cannot act is
   * not an assistant, and someone who asked for help does not want a narrator.
   */
  permission: PermissionMode;
  /** Ask before local writes at all. False means the ordinary gate still applies. */
  askBeforeEdits: boolean;
  /** How much the agent explains itself. `plain` avoids jargon entirely. */
  verbosity: Verbosity;
  /** Capability classes this user is offered. Not a security boundary — see INVARIANTS. */
  visibleCapabilities: Capability[];
  /** Whether the agent should propose a mode change (code vs computer) or just ask. */
  autoProposeMode: boolean;
  /** Repair passes after a blocked sign-off. Higher is not safer, just more persistent. */
  repairPasses: number;
}

const READ_ONLY_CAPS: Capability[] = ["read"];

export const PROFILES: Record<ProfileId, Profile> = {
  explorer: {
    id: "explorer",
    label: "Just getting started",
    blurb: "You tell me what you want in your own words. I explain what I'm about to do, in plain language, before I do it.",
    permission: "auto",
    askBeforeEdits: true,
    verbosity: "plain",
    // Narrow on purpose. The failure mode for a beginner is not being denied help, it
    // is being handed a shell they did not know was a shell.
    visibleCapabilities: ["read", "local-write"],
    autoProposeMode: false,
    repairPasses: 1,
  },
  general: {
    id: "general",
    label: "Comfortable with computers",
    blurb: "You use apps and the web every day. I handle files and settings and check with you before anything I can't undo.",
    permission: "auto",
    askBeforeEdits: true,
    verbosity: "brief",
    visibleCapabilities: ["read", "local-write", "destructive"],
    autoProposeMode: false,
    repairPasses: 1,
  },
  power: {
    id: "power",
    label: "Technical, not a developer",
    blurb: "You know your way around a machine but you don't write software. I work faster and check in less, but still before anything destructive.",
    permission: "auto",
    askBeforeEdits: false,
    verbosity: "brief",
    visibleCapabilities: ["read", "local-write", "destructive", "egress"],
    autoProposeMode: true,
    repairPasses: 1,
  },
  developer: {
    id: "developer",
    label: "Writes code",
    blurb: "You want the coding toolset with as little ceremony as possible. I keep changes small and Canary reviews every one.",
    permission: "auto",
    askBeforeEdits: false,
    verbosity: "terse",
    visibleCapabilities: ["read", "local-write", "destructive", "egress", "unbounded"],
    autoProposeMode: true,
    repairPasses: 1,
  },
  expert: {
    id: "expert",
    label: "Writes high-end code",
    blurb: "You mostly want correction, conversation, and verification. I assume you know what you're doing and stay out of the way.",
    permission: "auto",
    // Deliberately still "auto", never "full". An expert is the person most likely to
    // be running an agent with real credentials on a real machine, which is the
    // configuration OpenClaw's worst incidents all started from.
    askBeforeEdits: false,
    verbosity: "terse",
    visibleCapabilities: ["read", "local-write", "destructive", "egress", "unbounded"],
    autoProposeMode: true,
    repairPasses: 2,
  },
};

/**
 * What no profile may loosen.
 *
 * These are not preferences and they are not on the dial. Each one exists because a
 * documented incident showed what happens without it. A profile that turned one of
 * these off would be OpenClaw with better onboarding.
 */
export const INVARIANTS: ReadonlyArray<{ rule: string; because: string }> = [
  {
    rule: "Untrusted content can never reach an egress, destructive, or unbounded tool without consent, and that consent is never remembered.",
    because: "CVE-2026-25253: OpenClaw read a URL out of a query string and opened a connection, sending a token, without prompting.",
  },
  {
    rule: "A failing judge blocks the change rather than passing it.",
    because: "A gate that silently stops working is worse than no gate, because people stop checking whether it is on.",
  },
  {
    rule: "No agent can approve its own work.",
    because: "An agent that signs its own permission slip is not being governed, it is being asked nicely.",
  },
  {
    rule: "Shell is unbounded, and is treated as such.",
    because: "A shell command can read, destroy, and send. No check can prove otherwise, so pretending otherwise would be inventing a fact.",
  },
  {
    rule: "What the human typed is recorded as trusted; content from anywhere else is not.",
    because: "This is the distinction the model cannot make reliably, which is why the code makes it instead.",
  },
];

export interface Intake {
  /** "none" | "some" | "a lot" — have they written code? */
  codeBefore: "none" | "some" | "a lot";
  /** What they actually want to do most days. */
  wants: "files-and-apps" | "code" | "both";
  /** How they feel about being asked before something happens. */
  patience: "ask-everything" | "ask-when-it-matters" | "dont-ask";
}

/**
 * Map intake answers to a profile.
 *
 * Deterministic and dumb on purpose. Onboarding is exactly the wrong place for a model
 * to have an opinion: it decides the user's permission level, and a classification the
 * user never agreed to is the same failure mode as a silently inferred mode. The output
 * of this function is a *proposal*, and `classify` is always shown to the human before
 * it is stored.
 */
export function classify(intake: Intake): ProfileId {
  if (intake.codeBefore === "a lot" && intake.wants !== "files-and-apps") return "expert";
  if (intake.codeBefore === "some" || (intake.codeBefore === "a lot" && intake.wants === "files-and-apps")) {
    return "developer";
  }
  if (intake.codeBefore === "none" && intake.wants === "files-and-apps" && intake.patience === "ask-everything") {
    return "explorer";
  }
  if (intake.codeBefore === "none") return "general";
  return "power";
}

/**
 * Look up a profile, falling back to `general` for anything unknown.
 *
 * The fallback is deliberate: this reads from a config file and an environment
 * variable, both of which a user can mistype, and a typo must not stop the tool from
 * starting. `general` is the right resting place — it is the common case and it is not
 * the permissive one.
 */
export function profileById(id: ProfileId | string | undefined | null): Profile {
  if (typeof id !== "string") return PROFILES.general;
  const found = PROFILES[id as ProfileId];
  return found ?? PROFILES.general;
}

/** A plain-language summary, so the human can see what they are agreeing to. */
export function describeProfile(profile: Profile): string[] {
  return [
    profile.label,
    profile.blurb,
    `Permission mode: ${profile.permission}`,
    `Ask before editing files: ${profile.askBeforeEdits ? "yes" : "no"}`,
    `Tools offered: ${profile.visibleCapabilities.join(", ")}`,
    `Explanation style: ${profile.verbosity}`,
    "",
    "What no setting turns off:",
    ...INVARIANTS.map((invariant) => `  · ${invariant.rule}`),
  ];
}
