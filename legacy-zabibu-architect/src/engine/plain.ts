// Plain-English translation layer. The engine speaks in categories; people
// speak in consequences. Every finding becomes: what it is, why it matters,
// and what to do about it — no jargon.
import type { Finding } from "./analyze.ts";

export interface PlainFinding {
  cta: string;
  headline: string;
  why: string;
  fix: string;
}

const CTA: Record<string, string> = {
  critical: "Stop",
  high: "Be careful",
  medium: "Worth a look",
  low: "Good to know",
  info: "Good sign",
};

interface Entry {
  headline: string;
  why: string;
  fix: string;
}

const MAP: Record<string, Entry> = {
  "Environment file present in diff": {
    headline: "A file full of secrets is about to be shared",
    why: "This file holds real passwords and keys. Once it is shared, anyone who sees the code can use them to get into your accounts.",
    fix: "Keep this file out of the shared folder, and change every key inside it — they must now be treated as leaked.",
  },
  "Possible hardcoded secret in added lines": {
    headline: "A password or secret key is written right in the code",
    why: "Anyone who can see this code — teammates, or people who break in — can steal it and use it to get in.",
    fix: "Move it to a private settings file that is not shared (like .env), and change it now, because it has already been exposed.",
  },
  "Possible hardcoded secret in pasted text": {
    headline: "A password or secret key is written right in the text",
    why: "Anyone who can see this text can steal it and use it to get into your accounts.",
    fix: "Never paste real keys into chats or code. Move it to a private settings file (like .env), and change it — treat it as leaked.",
  },
  "Database schema or migration change": {
    headline: "This changes how your app stores information",
    why: "Storage changes affect every part of the app that reads that information — and they can be hard to undo.",
    fix: "Test it against a copy of your data first, and make sure you can undo it if something goes wrong.",
  },
  "Authentication / authorization surface touched": {
    headline: "This touches the parts that decide who gets in",
    why: "Sign-in and permission code decides who can see what. A mistake here can let the wrong people in — or lock everyone out.",
    fix: "Have a second person check this, and test signing in as a normal user and as an admin.",
  },
  "Dependency manifest changed": {
    headline: "A new outside tool is being added to the project",
    why: "Every new piece of outside code is code your app now trusts. Most are fine — some have caused famous security disasters.",
    fix: "Check what the tool does, who maintains it, and that it is still being updated.",
  },
  "Unpinned dependency version": {
    headline: "A new tool is added without locking its exact version",
    why: "If that tool updates and breaks something, your app can break too, with no warning.",
    fix: "Lock it to one exact version (like 1.2.3) instead of a moving target like latest.",
  },
  "Lockfile churn": {
    headline: "The full list of tool versions changed",
    why: "The list of everything your app uses just moved. That is normal during updates — it is just worth knowing it happened.",
    fix: "Skim it and make sure only what you meant to change is in there.",
  },
  "Infrastructure or CI configuration touched": {
    headline: "This changes how the app is put online",
    why: "Build and setup changes can break the whole going-live process, or accidentally expose settings.",
    fix: "Do a full test run somewhere private before the real one.",
  },
  "Large blast radius": {
    headline: "This is a big change",
    why: "Big changes are where mistakes hide — they are harder to review and harder to undo.",
    fix: "Consider splitting it into smaller pieces and checking each one.",
  },
  "Tests updated alongside change": {
    headline: "Tests were updated too — nice work",
    why: "When changes come with tests, mistakes get caught before your users find them.",
    fix: "Nothing to do — this is a good sign.",
  },
  "Code that runs text as commands": {
    headline: "The code runs text as if it were commands",
    why: "This lets attackers sneak in their own commands if they can influence even a word of that text.",
    fix: "Use the safe, built-in way to do the same thing — never run text as code.",
  },
  "Database command built by gluing text together": {
    headline: "A database command is built by gluing words together",
    why: "This is the classic opening for SQL injection — attackers can add their own commands to the pile.",
    fix: "Use the database's built-in safe queries (they are called parameterized queries or prepared statements).",
  },
  "Runs other programs from the code": {
    headline: "The code runs other programs on the computer",
    why: "If any of the text comes from a user, they may be able to run their own commands on the server.",
    fix: "Only run fixed, trusted commands — never pass user text into a terminal.",
  },
  "A web link without encryption": {
    headline: "A web link is missing the secure https:// part",
    why: "Anything sent over an unencrypted link can be read or changed while it travels.",
    fix: "Use https:// — most hosts provide it for free.",
  },
  "Keyboard focus outline removed": {
    headline: "The keyboard focus outline was switched off",
    why: "People who navigate with a keyboard or a switch device can no longer see where they are on the page — they are effectively lost.",
    fix: "Keep the focus ring, or replace it with an equally visible one (a 2px outline that matches your buttons).",
  },
  "Page zoom is blocked": {
    headline: "People are blocked from zooming the page",
    why: "Users with low vision enlarge text to read it. Blocking zoom locks them out of the page entirely.",
    fix: "Remove the zoom block from the page settings and let people zoom.",
  },
  "Clickable element keyboards cannot reach": {
    headline: "Something clickable cannot be reached without a mouse",
    why: "Keyboard users and screen readers cannot use it — a plain clickable box is invisible to them.",
    fix: "Use a real button element, or add keyboard support (Enter and Space keys) and a label.",
  },
};

export function plainify(f: Finding): PlainFinding {
  const entry = MAP[f.title];
  return {
    cta: CTA[f.severity] ?? "Good to know",
    headline: entry?.headline ?? f.title,
    why: entry?.why ?? f.detail,
    fix: entry?.fix ?? "Review this change with someone who knows the project.",
  };
}

export type VerdictTone = "stop" | "care" | "ok";

export interface Verdict {
  label: string;
  tone: VerdictTone;
}

export function verdictFor(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === "critical")) return { label: "Stop — fix these first", tone: "stop" };
  if (findings.some((f) => f.severity === "high")) return { label: "Check carefully before using", tone: "care" };
  if (findings.some((f) => f.severity === "medium")) return { label: "A few things worth knowing", tone: "ok" };
  return { label: "Looks good to go", tone: "ok" };
}

const GRADE_VERDICT: Record<string, Verdict> = {
  A: { label: "Looks good to go", tone: "ok" },
  B: { label: "Looks good to go", tone: "ok" },
  C: { label: "A few things worth knowing", tone: "ok" },
  D: { label: "Check carefully", tone: "care" },
  E: { label: "Stop — fix first", tone: "stop" },
};

export function verdictForGrade(grade: string): Verdict {
  return GRADE_VERDICT[grade] ?? GRADE_VERDICT.A;
}
