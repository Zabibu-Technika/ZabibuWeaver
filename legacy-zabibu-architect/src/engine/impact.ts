// Sector impact model: maps findings to the five damage sectors —
// security, trust, usage, accessibility, dependability.
// Pure functions; unit-tested with node:test.
import type { Finding } from "./analyze.ts";

export const SECTORS = ["security", "trust", "usage", "accessibility", "dependability"] as const;
export type Sector = (typeof SECTORS)[number];
export type Level = 0 | 1 | 2 | 3;

export const SECTOR_INFO: Record<Sector, { label: string; question: string }> = {
  security: {
    label: "Security",
    question: "Can the wrong people get in, or can data leak out?",
  },
  trust: {
    label: "Trust",
    question: "Can people believe the data — and prove who did what?",
  },
  usage: {
    label: "Usage",
    question: "Does the app keep working for everyone using it?",
  },
  accessibility: {
    label: "Accessibility",
    question: "Can everyone use it — including keyboard and screen-reader users?",
  },
  dependability: {
    label: "Dependability",
    question: "Can you rely on it over time — updates, crashes, and rollbacks?",
  },
};

type Impact = Partial<Record<Sector, Level>>;

const IMPACT_BY_CATEGORY: Record<string, Impact> = {
  secrets: { security: 3, trust: 2 },
  schema: { trust: 3, dependability: 2 },
  authorization: { security: 3, trust: 1, accessibility: 1 },
  injection: { security: 3 },
  "dangerous-code": { security: 2, dependability: 2 },
  "insecure-transport": { security: 2, trust: 1 },
  "supply-chain": { dependability: 3, security: 1 },
  infrastructure: { usage: 2, dependability: 2 },
  scope: { usage: 2, dependability: 1 },
  accessibility: { accessibility: 3 },
  tests: {},
};

export function findingSectors(f: Finding): Record<Sector, Level> {
  const impact = IMPACT_BY_CATEGORY[f.category] ?? {};
  const out = {} as Record<Sector, Level>;
  for (const s of SECTORS) out[s] = impact[s] ?? 0;
  return out;
}

export interface SectorImpact {
  level: Level;
  count: number;
}

export function sectorImpacts(findings: Finding[]): Record<Sector, SectorImpact> {
  const out = {} as Record<Sector, SectorImpact>;
  for (const s of SECTORS) out[s] = { level: 0, count: 0 };
  for (const f of findings) {
    const sectors = findingSectors(f);
    for (const s of SECTORS) {
      if (sectors[s] > 0) out[s].count += 1;
      if (sectors[s] > out[s].level) out[s].level = sectors[s];
    }
  }
  return out;
}
