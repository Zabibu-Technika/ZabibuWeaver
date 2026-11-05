// Action journal — reversibility for things that are not files.
//
// Checkpoints put files back. They cannot un-send an email, un-post a status, or
// un-charge a card. Those actions are the ones a multi-axis agent takes outside the
// project, and they are the ones where "undo" has to be written down *before* the action
// runs, because afterwards the only remaining option is to ask a human to clean up.
//
// So this is a two-phase journal:
//
//   plan  → "I am about to do X; the way back is Y"
//   commit → "X happened"
//   fail   → "X did not happen, and here is why"
//   compensate → "Y was done"
//
// The plan is written before the side effect. If the process dies between plan and
// commit, the action is left in `pending` and is visible as something to check — which
// is the honest state, since we genuinely do not know whether it landed.
//
// An action with no compensation is recorded as irreversible rather than quietly
// omitted. A journal that only lists the reversible things is a journal that lies by
// omission.
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ActionStatus = "pending" | "applied" | "failed" | "compensated";

export interface ActionEvent {
  id: string;
  at: string;
  action: string;
  detail: string;
  target?: string;
  /** How to undo it, in words a human can follow. Null means it cannot be undone. */
  compensation: string | null;
  irreversible: boolean;
  status: ActionStatus;
  /** Present on later events: which plan this event refers to. */
  ref?: string;
  note?: string;
}

export interface NewAction {
  action: string;
  detail: string;
  target?: string;
  compensation: string | null;
}

export interface Journal {
  file: string;
}

export function journalFor(workspace: string): Journal {
  return { file: join(resolve(workspace), ".weaver", "actions.jsonl") };
}

function makeId(action: string, detail: string): string {
  // Randomness as well as time: two identical actions planned in the same millisecond
  // must not share an id, because the id is how a compensation is matched to its effect.
  const salt = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return createHash("sha256").update(`${action}\u0000${detail}\u0000${salt}`).digest("hex").slice(0, 16);
}

/** Append one record, repairing a half-written tail first — see decisions.ts. */
async function append(journal: Journal, event: ActionEvent): Promise<void> {
  const file = journal.file;
  await mkdir(dirname(file), { recursive: true });
  let needsNewline = false;
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const buffer = Buffer.alloc(1);
        await handle.read(buffer, 0, 1, size - 1);
        needsNewline = buffer[0] !== 0x0a;
      }
    } finally {
      await handle.close();
    }
  } catch {
    // New journal.
  }
  await appendFile(file, `${needsNewline ? "\n" : ""}${JSON.stringify(event)}\n`, "utf8");
}

function clip(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * Write the plan, before the side effect. Returns the id to commit or fail.
 */
export async function plan(journal: Journal, input: NewAction): Promise<ActionEvent> {
  const action = input.action.trim();
  const detail = input.detail.trim();
  if (action.length === 0) throw new Error("action must not be empty");
  if (detail.length === 0) throw new Error("detail must not be empty");

  const event: ActionEvent = {
    id: makeId(action, detail),
    at: new Date().toISOString(),
    action: clip(action, 120),
    detail: clip(detail, 2_000),
    compensation: input.compensation === null ? null : clip(input.compensation, 2_000),
    irreversible: input.compensation === null,
    status: "pending",
  };
  if (input.target !== undefined) event.target = clip(input.target, 1_000);
  await append(journal, event);
  return event;
}

async function transition(
  journal: Journal,
  id: string,
  status: ActionStatus,
  note?: string,
): Promise<ActionEvent | null> {
  const events = await read(journal);
  const origin = events.find((event) => event.id === id && event.ref === undefined);
  if (origin === undefined) return null;

  const event: ActionEvent = {
    id: `${id}-${status}-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    action: origin.action,
    detail: origin.detail,
    compensation: origin.compensation,
    irreversible: origin.irreversible,
    status,
    ref: id,
  };
  if (origin.target !== undefined) event.target = origin.target;
  if (note !== undefined) event.note = clip(note, 1_000);
  await append(journal, event);
  return event;
}

export function commit(journal: Journal, id: string): Promise<ActionEvent | null> {
  return transition(journal, id, "applied");
}

export function fail(journal: Journal, id: string, reason: string): Promise<ActionEvent | null> {
  return transition(journal, id, "failed", reason);
}

export function compensate(journal: Journal, id: string, note?: string): Promise<ActionEvent | null> {
  return transition(journal, id, "compensated", note);
}

export async function read(journal: Journal): Promise<ActionEvent[]> {
  let raw: string;
  try {
    raw = await readFile(journal.file, "utf8");
  } catch {
    return [];
  }
  const events: ActionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as ActionEvent;
      if (typeof parsed.id === "string" && typeof parsed.action === "string") events.push(parsed);
    } catch {
      // A torn line is one lost event, not a lost journal.
    }
  }
  return events;
}

export interface ActionState {
  id: string;
  action: string;
  detail: string;
  target?: string;
  compensation: string | null;
  irreversible: boolean;
  status: ActionStatus;
  at: string;
  note?: string;
}

/**
 * The current state of every action, with all its events folded into one record.
 *
 * `pending` is deliberately included: an action planned but neither committed nor failed
 * is the one a human most needs to see, because the process cannot tell them whether it
 * landed.
 */
export async function states(journal: Journal): Promise<ActionState[]> {
  const events = await read(journal);
  const byId = new Map<string, ActionState>();
  for (const event of events) {
    const originId = event.ref ?? event.id;
    if (event.ref === undefined) {
      byId.set(originId, {
        id: originId,
        action: event.action,
        detail: event.detail,
        target: event.target,
        compensation: event.compensation,
        irreversible: event.irreversible,
        status: event.status,
        at: event.at,
      });
      continue;
    }
    const state = byId.get(originId);
    if (state === undefined) continue;
    state.status = event.status;
    if (event.note !== undefined) state.note = event.note;
  }
  return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Actions that still need a human: planned-but-unknown, applied-and-not-undone. */
export async function openActions(journal: Journal): Promise<ActionState[]> {
  return (await states(journal)).filter((state) => state.status === "pending" || state.status === "applied");
}
