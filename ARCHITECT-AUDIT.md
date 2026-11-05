# Architect audit

The original **Zabibu Architect** skeleton lives at `legacy-zabibu-architect/` as a frozen
copy. This file records what it contained, where each piece lives now, and what was
deliberately retired — so "incorporate Architect fully" is a checkable claim rather than a
feeling.

## Result

**47 of 47 modules are present in `src/`.** Nothing from the legacy tree was dropped. Most
modules were extended in place; a few concerns moved into `core/` so Arif Agent can inherit
them without copying the runtime.

The check is mechanical:

```powershell
$legacy  = "legacy-zabibu-architect/src"
$current = "src"
Get-ChildItem -Recurse -File $legacy |
  ForEach-Object { $_.FullName.Substring($legacy.Length + 1) } |
  Where-Object { -not (Test-Path (Join-Path $current $_)) }
# no output
```

## Where each area lives

| Architect area | Legacy files | Current home | State |
| --- | --- | --- | --- |
| CLI and config | `config.ts`, `index.ts`, `setup.ts`, `cli/*` | same paths | Extended with `checkpoints`, `undo`, `decisions`, `verify`, `receipts`, `integrations` |
| Agent loop | `core/agent.ts`, `prompt.ts`, `session.ts`, `types.ts` | same paths | Extended with compaction, verification, receipts, scope pushback, provenance gating |
| Safety | `permissions/gate.ts`, `safety/checkpoints.ts`, `safety/sandbox.ts`, `trust/taint.ts` | same paths | Extended with `undo`, the action journal, and the narrowed egress gate |
| Memory | `memory/graph.ts` | same path | Present. The graph is trust-gated but still has no capture path — see the gap below |
| Onboarding | `onboard/profiles.ts` | same path | Active; profiles drive friction, never trust |
| Providers | `providers/*` | same paths | Extended with context windows and the language-tax estimator |
| Tools | `tools/files.ts`, `tools/index.ts`, `tools/shell.ts` | same paths | Extended with the shared tool contract and external-ingest labels |
| TUI | `tui/ansi.ts`, `app.ts`, `frame.ts`, `index.ts`, `keys.ts` | same paths | Extended: styled spans, syntax highlighting, gradient, overlay, palette, tool cards |
| Judge | `integrate/canary.ts` | same path | Byte-pinned engine under `src/engine/`, plus proof receipts |
| Docs | `README.md`, `EDGE.md`, `COMPETITORS.md`, `SAFETY.md`, `GEMINI-BRIEF.md`, `LINEAGE.md` | repository root | Kept and updated |

## What moved into `core/` for Arif Agent

These are new shared modules, not replacements for legacy code:

- `core/contracts/` — the tool and workspace contract.
- `core/verification/` — checks and proof receipts.
- `core/memory/decisions.ts` — the decision ledger.
- `core/safety/rollback.ts` and `core/safety/scope.ts` — the action journal and friction.
- `core/routing/` — the budget guard and model choice.
- `core/tui/` — `ansi`, `keys`, `box`, `canvas`, `style`, `rich`, `highlight`, `overlay`.
- `core/integrations/` — GitHub, Vercel, and manifest-driven CLIs.
- `engines/coding/` — the coding engine contract.

## Deliberately retired

| Item | Why |
| --- | --- |
| `sync.ps1` | It mirrored the whole project into another folder. Arif Agent now has a conflict-aware sync daemon (`arif-agent/sync-daemon.py`) with hashes and refusal to overwrite local edits. |
| The old mirror directory | Keeping a second copy of the same source was the problem, not the backup. `legacy-zabibu-architect/` is the read-only record. |
| The old TUI layout | Superseded by the shared `core/tui` layer. The legacy frame code still exists in the frozen copy; the live one has spans, overlays, and the pending-wrap fix. |

## New this pass, not ports

The legacy `setup.ts` only picked a provider. Hardware-aware onboarding (CPU/RAM/disk/admin,
a model that fits, an optional Ollama pull) and the single base workspace were **not** in the
Architect tree. They are new work, tracked as `SD13` and `SD14`; the module audit is still
47/47.

## Known gap

`memory/graph.ts` — the phrase-to-referent knowledge graph — is present and tested, but
nothing captures into it yet. It is the one Architect feature that is *present* without being
*active*. Wiring it needs a capture/confirm path (the agent resolves "the dashboard", the
user confirms, the entry is stored with `user` provenance), which is tracked in the roadmap as
`M3`.
