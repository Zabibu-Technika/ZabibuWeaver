// The judging engine, vendored from Canary.
//
// NOT vendored — this file is Weaver's own. It exists so `src/engine/` has a
// stable entry point without copying Canary's `index.ts`, which also re-exports
// `ledger.ts` (the signing half) and `demo-diff.ts` (a self-test). Weaver embeds
// the judge, not the pen: it can be judged, but it must not be able to sign its
// own permission slip.
//
// `analyze.ts`, `impact.ts` and `plain.ts` are byte-for-byte copies pinned by
// `provenance.json`. Do not edit them — `provenance.test.ts` recomputes their
// hashes and will fail. Re-vendor with `npm run vendor:engine`.
//
// This directory is excluded from the main `tsconfig.json` and checked by its own
// (`src/engine/tsconfig.json`, `npm run typecheck:engine`), because it is a
// dependency and is checked the way its authors checked it. `canary.ts` loads it
// through a computed specifier for the same reason.
//
// The three vendored modules have no imports beyond each other, so the closure is
// self-contained and runs on a bare Node install with nothing else present.
export * from "./analyze.ts";
export * from "./impact.ts";
export * from "./plain.ts";
