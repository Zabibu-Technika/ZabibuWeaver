// Session persistence: one JSON file per session under ~/.weaver/sessions.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "./types.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
  title: string;
  provider: string;
  model: string;
  workspace: string;
}

export interface StoredSession {
  meta: SessionMeta;
  messages: ChatMessage[];
}

export function sessionsDir(home: string = join(homedir(), ".weaver")): string {
  return join(home, "sessions");
}

export function newSessionId(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}_${time}`;
}

export function saveSession(home: string, session: StoredSession): void {
  const dir = sessionsDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session.meta.id}.json`), JSON.stringify(session, null, 2), "utf8");
}

export function loadSession(home: string, id: string): StoredSession | null {
  const file = join(sessionsDir(home), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredSession;
  } catch {
    return null;
  }
}

export function listSessions(home: string): SessionMeta[] {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  const found: SessionMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const session = loadSession(home, entry.slice(0, -5));
    if (session) found.push(session.meta);
  }
  return found.sort((a, b) => (a.id < b.id ? 1 : -1));
}
