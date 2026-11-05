# Weaver Lineage

A record of every version that shipped, what changed, and why — so the next reviewer
starts from where we are, not from scratch.

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