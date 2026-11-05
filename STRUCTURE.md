# Architecture

Two products, one core, as siblings.

```
Projects/Zabibu Architect/
│
├── Zabibu Weaver/                  # mono-axis: software engineering
│   ├── core/                       # shared, axis-agnostic
│   │   ├── contracts/              # tool + workspace contract (copy-safe)
│   │   ├── verification/           # proof of state: checks + receipts
│   │   ├── memory/                 # decision ledger (why, not just what)
│   │   ├── safety/                 # rollback journal + scope pushback
│   │   ├── routing/                # budget guard + model selection
│   │   ├── integrations/           # GitHub / Vercel / manifest CLIs
│   │   └── tui/                    # ansi, keys, boxes, spans, overlay
│   ├── engines/
│   │   └── coding/                 # the coding engine contract
│   ├── src/                        # the current runnable Weaver
│   └── legacy-zabibu-architect/    # archived skeleton
│
└── Arif Agent/                     # multi-axis: code + growth + business ops
    ├── core/                       # generated copy of ../Zabibu Weaver/core
    ├── engines/
    │   ├── coding/                 # generated copy
    │   ├── growth/                 # owned: analytics, social queue, publishing
    │   └── bizops/                 # owned: invoices, CRM outbox
    ├── cli/                        # dashboard, commands, accounts, palette
    ├── bin/arif-agent.mjs          # entry point
    ├── docs/tui.md                 # rendered frame
    ├── scripts/smoke-tui.mjs       # headless dashboard smoke
    ├── sync-daemon.py              # keeps the inherited copy honest
    └── package.json
```

## One rule about where code lives

`src/` is the **running** Weaver engine today: the agent loop, tools, TUI, Canary
integration, trust layer, checkpoints. It is not duplicated and it is not being rewritten.

`core/` and `engines/` are the **architecture** layer: shared modules both products need.
New work lands there. Existing work migrates when it is touched, not in a big-bang rename
that breaks tests and buys nothing.

The four core modules are standalone (Node builtins only) precisely so Arif Agent can inherit
them by copy without dragging Weaver's runtime along.

## The five pillars

| Pillar | Where it lives | State |
| --- | --- | --- |
| Proof-of-state verification | `core/verification/`, called in `runTurn` before sign-off | working |
| Decision-ledger memory | `core/memory/decisions.ts`, injected into the prompt, written on a Canary block | working |
| True reversibility | `src/safety/checkpoints.ts` + `weaver undo`; `core/safety/rollback.ts` for non-file actions | files working; external-action journal ready |
| Scope & friction pushback | `core/safety/scope.ts`, surfaced at the start of every turn | working |
| Resumable tasks & token budgeting | `src/core/compact.ts`, sessions, `core/routing/` | compaction + sessions working; routing ready |

"Ready" means implemented and tested but not yet on the hot path. That distinction is
explicit because an inert safety feature is worse than a missing one: it looks like
coverage.

## Why verification runs before the sign-off

`runTurn` does: model loop → **verify** → Canary sign-off.

Verification answers "does the project still work?" The sign-off answers "is this change
acceptable?" In that order, the judge sees the final diff, and a repair pass triggered by
failing tests is judged like any other change.

Verification is skipped when the workspace *is* Weaver's own root. Running the engine's
suite from inside an engine turn is recursion, not proof.

## Why Arif Agent is a sibling, not a fork

A fork drifts, and the first thing to drift is a safety default. Arif Agent inherits `core/` and
`engines/coding/` through `sync-daemon.py`, which is deliberately suspicious: it hashes
every file it copies, and if a downstream file no longer matches what it last wrote, it
reports a conflict instead of overwriting a human's edit.

The inherited copies are generated, so they are gitignored. After pulling Weaver:

```bash
cd "../Arif Agent" && npm run sync      # or, from Weaver: npm run sync:arif-agent
npm run check                           # exit 1 if the copy has drifted
```

Two guarantees keep this honest:

- **Decoupled:** Arif Agent imports nothing from Weaver's `src/` — only Node builtins and its
  inherited `core/`. You can read, test, and run its engines without Weaver present.
- **Current:** `npm test` in Arif Agent runs the sync first (`pretest`), so it cannot quietly
  test a stale core. From Weaver, `npm run sync:arif-agent:check` fails CI on drift.

## What is intentionally not here yet

- Model routing is a tested policy, not yet wired into the request path.
- The action journal is used by Arif Agent's publisher. Other external actions still need to
  adopt it, so that compensation is written *before* the effect, not after.
- Arif Agent has a dashboard and CLI. It still has no LLM loop — that should be extracted into
  `core/`, not copied from `src/`.
- Integrations are read-only until a switch is confirmed. The CLI remains the source of truth;
  the workspace file is a preference, not a claim about what is currently active.
- The Vercel adapter is JSON-first with a table fallback because its CLI has no stable
  "active scope" field on every version. When it cannot tell, it says so rather than guessing.
- The coding engine manifest is a contract; the runnable tools still live in `src/tools`.

## Where the plan lives

**[ROADMAP.md](ROADMAP.md)** is the single tracker. It maps every gap from the market
analysis to a workstream, a status, and the test that would close it — including the
African-realities and self-dependence workstreams, which are engineering constraints
rather than themes.

**[ARCHITECT-AUDIT.md](ARCHITECT-AUDIT.md)** records what the legacy Architect tree
contained, where each module lives now, and the few pieces deliberately retired.
