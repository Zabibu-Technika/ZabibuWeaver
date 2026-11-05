# Weaver Lineage

A record of every version that shipped, what changed, and why — so the next reviewer
starts from where we are, not from scratch.

---

## Arif Agent v0.2.0 — 2026-11-04

### Its own dashboard

Arif Agent now has a dashboard and a CLI, not just engines. `arif-agent` opens a
rail/pane/command-line TUI over the growth and bizops tools; `arif-agent status` prints the
same snapshot for scripts. Every dashboard command is also a CLI verb, and both use one
parser.

### Shared terminal core

`ansi`, `keys`, `box`, and `canvas` moved into `core/tui/`. Weaver's `src/tui` re-exports
them, and Arif Agent inherits them through the sync daemon, so there is one implementation
of the width and pending-wrap rules instead of two that drift.

### Naming

The product is **Arif Agent** everywhere: the binary is `arif-agent`, state lives in
`.arif-agent/`, and the environment variables are `ARIF_AGENT_PUBLISH_ENDPOINT` and
`ARIF_AGENT_CURRENCY`. The old `ARIF_*` names are still read as fallbacks. Bare "Arif"
refers to the separate product, so it is not used for this one.

### Verification

- Weaver: 335 tests, 333 pass, 2 skipped
- Arif Agent: 21 tests (10 dashboard/CLI, 11 engines)
- Both typechecks clean; Weaver's TUI smoke and Arif Agent's dashboard smoke pass
- Sync check: up to date

---

## v0.7.0 — 2026-11-04

### Proof receipts — evidence, not assertion

The gap this closes is the one every agent shares: a turn ends with "done", and the
evidence that it *is* done lives in a terminal that scrolls away. Now a mutating turn
writes a receipt to `.weaver/receipts/`:

- `.json` for tooling, `.md` for a human
- which commands ran, their exit codes, timing, and a sha256 of their output
- **not** the output itself, because a failing test can print a token and a receipts
  directory is exactly the thing people later zip and send to someone
- the Canary analysis id, when a judge ran
- every path the turn touched

`weaver receipts` lists them; `weaver receipts show <id>` prints one. `weaver verify`
writes one too.

### The status is evidence-based, not self-reported

| Status | Meaning |
| --- | --- |
| `proved` | every detected check passed, none was authored by this turn, nothing skipped |
| `partial` | something passed, but the proof is incomplete or not independent |
| `unproven` | no checks ran. This is not a pass |
| `failed` | a check ran and failed |

The load-bearing rule is **self-authored detection**. If the turn edited a test file, a
test directory, a test config, or a check command (`package.json`, `tsconfig.json`,
`Cargo.toml`, `go.mod`), a green run is capped at `partial`. An agent that writes a test
asserting nothing and then reports a pass has produced a confidence trick with extra
steps; the receipt says so.

This is also why there is no model-reported confidence percentage. A number the model
invents is not calibration. `proved — 3/3 checks passed` is a claim you can check;
"I'm 80% sure" is not.

### Tests

- Weaver: 327 tests, 325 pass, 2 skipped
- Arif Agent: 11 engine tests pass (inherits the receipt module through `core/`)
- Both typechecks clean; 3 smokes pass
- The receipt wiring is covered end to end: a mutating turn runs the checks, writes a
  `proved` receipt, and a turn that edits a test is capped at `partial`

---

## v0.6.0 — 2026-11-04

### Compaction — a session that survives its own context limit

Without this, every long task ended the same way: the provider rejects the request, the
turn dies, and the work is stranded. Now older turns are summarized into a structured
brief and the recent turns are kept verbatim.

- Automatic when the conversation plus the system prompt and tool schemas approaches the
  window; `WEAVER_CONTEXT`, `WEAVER_COMPACT_KEEP`, `WEAVER_COMPACT_BUFFER`,
  `WEAVER_COMPACT=off`.
- A too-long rejection compacts and retries **once**, bounded so a broken request cannot
  loop.
- The summary is inserted as a *system* message explicitly labelled as untrusted
  background, because it was written from content the model read.
- A summarizer failure degrades to dropping the head and says so (`degraded: true`)
  rather than killing the turn.

### The language tax is in the estimator

Measured across 20 African languages (arXiv:2606.24460), the median tokenizer premium
over English is 1.88x, 7.4x for Amharic, and 8.92x for N'Ko — leaving some speakers with
as little as 11% of the effective context window. `estimateTokens` charges non-Latin
codepoints at 1.7 tokens each instead of 0.25. It is a deliberate overestimate: running
out of context is a hard failure; compacting early is not.

**Bug found by the tests:** the first split required a `user`-message boundary, which
meant a single-prompt agentic task (the exact case compaction exists for) could never be
compacted. The correct invariant is narrower: the tail must not begin with a `tool`
result. Fixed, with a regression test.

### Proof of state

`core/verification/` detects the project's checks (package scripts, tsc fallback, cargo,
go) and runs them after a mutating turn, before the sign-off. A failure is handed back to
the model for a bounded repair pass. Commands come from the project manifest, never from
the model. Skipped for Weaver's own root to avoid recursion.

### Decision ledger

`core/memory/decisions.ts`: append-only JSONL of choices, rejections, constraints, and
assumptions. Superseding appends; it never edits. Active decisions are injected into the
system prompt, bounded, so the agent stops re-litigating what was already settled. A
Canary block is recorded automatically.

**Bug found by the tests:** a torn final line (power loss) caused the next append to
concatenate onto the fragment and destroy the new record too. Both ledgers now repair a
missing trailing newline before appending.

### Scope pushback

`core/safety/scope.ts` reads the request deterministically and surfaces risk before work
starts: destructive verbs aimed at a whole scope, credentials plus an outbound action,
dependency additions, production deploys, bundled objectives. It is friction, not a veto.

### Two products, one core

- `core/` now owns the tool contract (`contracts/tool.ts`) and the workspace guard
  (`contracts/workspace.ts`); `src/core/types.ts` and `src/tools/files.ts` re-export them.
- `Arif Agent/` is a **sibling** project: it owns growth and bizops engines and inherits
  `core/` + `engines/coding/` through `sync-daemon.py`, which refuses to overwrite a
  downstream edit without `--force`.
- `core/safety/rollback.ts`: a two-phase journal for non-file actions, so a compensation
  is written before the side effect runs.
- `core/routing/`: a budget guard and deterministic model selection. Tested; not yet on
  the hot path.

### Fixes after the first pass

- **Scope false positives.** "message" and "post" in ordinary coding requests ("fix the
  error message", "add a blog post page") were treated as outbound actions. The send-verb
  set is now narrow, with a broader set used only for the credential-exfiltration rule.
- **Invoices were dated in UTC.** An invoice issued at 00:30 in Nairobi was dated the
  previous day — which changes payment terms and, in some jurisdictions, the tax period.
  Local calendar dates now.
- **Same-day invoices overwrote each other.** Filenames now include a local timestamp and
  a short random suffix.
- **Publishing the same queued post twice posted twice.** The outbox is checked first, and
  the action is planned through `core/safety/rollback.ts` before the request: the
  compensation is written while it is still true.
- **`--prune` could delete everything if an upstream source was missing.** Absence is not
  evidence when the checkout is incomplete.
- **A hung check on POSIX left grandchildren running.** Checks now spawn into their own
  process group and the timeout kills the group.
- **`mutated` was session-scoped**, so every read-only turn after the first edit re-ran the
  suite and re-judged an unchanged diff. It is now per-turn.
- **Two identical rollback plans in the same millisecond shared an id**, which would
  compensate the wrong effect.
- **An unknown CRM stage was silently downgraded to `lead`.** Refused now.
- **The CSV cap compared characters, not bytes.** Non-Latin exports could exceed it.

### Tests

- Weaver: 319 tests, 317 pass, 2 skipped
- Arif Agent: 11 engine tests pass
- Both typechecks clean; 3 smokes pass; Arif Agent sync check clean

---

## v0.5.2 — 2026-10-29

### The undo surface

Checkpoints existed and were taken before every change, but there was no way for a user
to reach them. That made the safety story half-true, so this release finishes it.

- `weaver checkpoints` — list undo points, newest first, with what each call touched
- `weaver checkpoints diff <id>` — exactly what a restore would change, without changing it
- `weaver undo [id]` — restore, after showing the preview and asking
- `/undo` then `/undo yes` in the TUI and plain REPL
- `--yes` for scripts; a non-interactive run without it refuses rather than guessing

### What undo got right

- **Shell-created files.** A sweep now compares the current tree against the captured
  set, so `touch deploy.sh` followed by undo actually removes it. This only happens when
  the sweep enumerated the whole tree; a truncated sweep refuses to guess, because
  absence is only evidence if you saw everything.
- **Precise captures never delete the rest of the project.** `capture()` names one file,
  so it records `scope: "paths"`; treating it as a survey would delete every other file.
  There is a test that fails if this guard is removed.
- **Successive undos walk backwards**, one checkpoint at a time, instead of repeating.
- **A partial undo keeps its record**, moved to `index/failed/` — out of the undo chain
  so it cannot be replayed by accident, but not forgotten.
- **The store ignores itself in git.** `.weaver/.gitignore` contains `*`, so the agent
  directory never pollutes `git status`, a user's diff, or a Canary sign-off. The canary
  smoke test caught this: `.weaver/` was being reported as an uncovered untracked file.

### Version number

`--version` now reads `package.json` instead of a constant that had drifted to `0.2.0`
while the package was at `0.5.1`.

### Tests

- 262 pass (was 254)
- Both typechecks clean
- 3 smokes pass

---

## v0.5.1 — 2026-10-21

### Taint hole closed

The critical fix. File reads were labelled `local`; an attacker who clones a repo controls
the filesystem, so a read of their file was trusted as "local" output. Now all four read
tools (`read_file`, `list_dir`, `glob_files`, `grep`) declare `ingest: "external"`.

### Trust layer: provenance rewritten

| Before | After |
|--------|-------|
| `local` = "not from network" | `user` = explicitly confirmed by the human |
| `external` = "from network" | `external` = **output of any tool that fetches** (network, git clone, package manager, file read) |
| `unverified` didn't exist | `unverified` = model-inferred, never authoritative |

The rule: only `user`-confirmed entries are authoritative in the knowledge graph. An
external-derived entry is marked `unverified` and cannot be promoted by inference.

### Gate narrowed by one axis

Shell commands are now judged by **reading the command**, not just by capability:

- `npm test` → `local-write` (stays in workspace, no egress)
- `curl https://evil.test` → `egress` (context-gated every time)
- `wget`, `git clone`, `npm install` → `egress` (supply chain is egress)
- `OUTBOUND_COMMAND` regex catches the protocol (`wss://` was the actual CVE-2026-25253 protocol, not just `https://`)

A command that reaches outside gets no containment prefix even when one is available —
advertising a fence that doesn't address the actual route out is worse than advertising
none.

### Checkpoints: content-addressed, bounded, honest

`src/safety/checkpoints.ts` + `src/safety/checkpoints.test.ts` (15/15):

- `capture` — precise pre-state for `write_file` / `edit_file` (knows the target)
- `captureWorkspace` — bounded sweep for `run_shell` (max 4MB/file, 64MB total, 4000 files)
- **skipped list**: every file the sweep declined is recorded, never silent
- **rotation**: drops oldest, never orphans a blob a survivor still references
- `diff` / `restore` / `list` / `stats` — the CLI verbs a non-developer needs
- Not shadow-git: git init ~2.3s on this machine; Cline's per-call shadow-git would be
  disabled within a day

### Sandbox: detect + plan + disclose, never a fixed design

`src/safety/sandbox.ts` + `src/safety/sandbox.test.ts` (12/12):

- `detect()` — Linux Landlock / macOS Seatbelt / Windows WSL / `none`
- `plan()` — returns argv + **shell prefix** (Seatbelt only; WSL/Landlock stay argv-only)
- `disclosureText()` / `needsDisclosure()` — absence of containment is a first-class
  disclosure, not silence
- **WSL path bug fixed**: drive letter lowercased (`/mnt/c`, not `/mnt/C`)
- CVE-2026-87987 defence: no string-flattening where two parsers sit between intent and exec

### Wired into the agent loop

- Checkpoint taken **before** every mutating call, disclosed if incomplete
- Sandbox detected once per session, disclosed once when absent
- `run_shell` receives and honours the Seatbelt prefix; WSL/Landlock paths documented as
  argv-only (will need a typed argv API to use)

### Tests

- 99/99 pass (was 94)
- Both typechecks clean
- 3 smokes pass

---

## v0.5.0 — 2026-10-20

### Trust layer

- Provenance (`user`/`local`/`external`) — `local` now means "output of a local process
  that did not fetch"; file content is `external`
- Tools declare capability (`read`/`local-write`/`destructive`/`egress`/`unbounded`)
- High-risk call influenced by untrusted content → consent every time, no `always allow`
- Taint tracked value-level (filter) + context-level (guarantee)
- Disclosure survives `--permission full`

### Profiles

One dial (`explorer`→`general`→`power`→`developer`→`expert`) controls
friction/exposure/verbosity only. Trust boundaries live in `INVARIANTS`, not profile
fields; a test fails if a bypass-shaped field is added.

### Knowledge graph

Built on the trust layer — only `user`-confirmed entries authoritative, external-derived
marked `unverified`, reject list cannot be overridden by inference; bounded context
injection (~180 tokens vs ~4000 for 12 references).

### Fix-verify loop (v0.4.0)

Bounded by `WEAVER_CANARY_REPAIR` (default 1, cap 5); failing judge never handed to the
model; unchanged `analysisId` stops the loop.

### Engine embed (v0.3.0)

Vendored Canary engine in `src/engine/` — byte-for-byte, hash-pinned, never edited.
`ledger.ts` deliberately NOT vendored — Weaver embeds the judge, not the pen.

---

## v0.2.0 — 2026-10-15

TUI, free providers, subcommands, docs, tests, mirror. TUI border bug fixed
(`encodeFrame` in `src/tui/frame.ts`); `scripts/smoke-tui.mjs` has a mini terminal
emulator proving the old bug reproduced.