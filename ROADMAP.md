# Roadmap — Weaver & Arif Agent

This is the single tracker for everything in the market analysis: the gaps every agent
shares, the best ideas worth stealing, and the two themes that decide whether any of it
matters outside a San Francisco demo — **resilience on African infrastructure** and
**self-dependence**.

## How to read this

| Status | Means |
| --- | --- |
| `shipped` | In the product, tested, and exercised by a smoke or integration test. |
| `ready` | Built and tested, but not on the hot path. An inert safety feature is worse than a missing one, so these are called out explicitly. |
| `partial` | Some of it works; the missing part is named. |
| `todo` | Not started. |
| `hold` | Deliberately blocked on something else, with the reason. |
| `never` | Anti-goal. Listed so nobody "helpfully" adds it later. |

Rules for keeping this honest:

1. **A row is `shipped` only when its acceptance test runs in CI.** A feature that was
   demonstrated once is `partial`.
2. **IDs are stable.** Update status and next step; never delete a row. If an item is
   dropped, mark it `never` and say why.
3. **Every release updates this file** and appends to the changelog at the bottom.
4. **No status without evidence.** Link the test or the command that proves it.

## North star

> An agent that proves what it did, remembers why, can undo it, and still works when the
> network, the grid, or the budget does not.

The differentiator is not breadth. It is that Weaver treats **"proved it"** as the finish
line and **"wrote it"** as the halfway point — and that it remains useful on a 4 GB
Android phone with a prepaid data bundle.

*State at v0.7.0: the verification, decision, rollback, scope, compaction, receipt, and
multi-account integration layers are shipped, along with the overlay/palette foundation.
Cost metering, lineage, and reach are the next frontier.*

---

## A. Proof & Honesty

The thesis. An agent's report is a claim; a receipt is evidence. Every item here exists
to make the gap between the two visible.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| P1 | Run the project's own checks before "done" | `shipped` | `core/verification`, called before sign-off. Integration test: failing suite triggers a repair pass. |
| P2 | Durable proof receipts (JSON + Markdown) | `shipped` | `.weaver/receipts/`. Acceptance: every mutating turn writes one. |
| P3 | Detect when the turn authored its own judge | `shipped` | Test/config paths cap status at `partial`. Regression test in `receipt.test.ts`. |
| P4 | Evidence-based status labels | `shipped` | `proved · partial · unproven · failed`. No model-reported percentage. |
| P5 | Say what was **not** checked | `shipped` | `skipped` list in every receipt; `unproven` is never rendered as a pass. |
| P6 | Export/share a receipt as one file | `todo` | `weaver receipts export <id>` produces a self-contained Markdown bundle. |
| P7 | Urgency calibration | `todo` | Do not infer urgency. Ask when a request contains "now/asap/production"; record the answer. |
| P8 | Unified audit trail across turn events | `partial` | Receipts + checkpoints + action journal exist separately. Acceptance: one `weaver audit` view joins them by turn id. |
| P9 | Verify the *running app*, not only the suite | `todo` | Optional `verify.smoke` command + artifact (screenshot or HTTP probe). Antigravity's idea, done honestly. |

**Why P9 matters:** a passing unit suite does not prove the page renders. The receipt
should say which kind of proof it has.

---

## B. Memory & Lineage

Fact memory is common; decision memory is rare; **lineage** is almost absent. Weaver has
the first two. The third is what stops an agent renaming a column and breaking a
dashboard it never opened.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| M1 | Decision ledger (why, alternatives, constraints) | `shipped` | `core/memory/decisions.ts`, injected into the prompt, written on a Canary block. |
| M2 | Supersede/reject from the CLI | `todo` | `weaver decisions supersede <id> <title> :: <why>`. |
| M3 | Fact/knowledge graph capture | `ready` | Graph is built and trust-gated; no capture path. Acceptance: a resolved reference is stored and reused next turn. |
| M4 | Living specification engine | `todo` | `SPEC.md` + machine-readable invariants, each with a check command. An invariant without a test is a comment. |
| M5 | Semantic + metadata lineage graph | `todo` | Map modules → schemas → API contracts → downstream consumers. Acceptance: editing a schema field reports affected consumers before the edit. |
| M6 | Dependency-impact analysis | `todo` | Uses M5. Acceptance: a rename lists direct and transitive references outside the search boundary. |
| M7 | Memory poisoning defences | `shipped` | Provenance gate: only `user`-confirmed entries are authoritative; external-derived are `unverified`. |
| M8 | Inspect and edit memory | `partial` | Read/add shipped; edit/supersede/export are not. |
| M9 | Memory export/import | `todo` | Plain JSONL in, plain JSONL out. No proprietary store. |

**Why M4 before M5:** a lineage graph without an explicit specification is a graph of
guesses. The spec says what must remain true; the graph says what will break.

---

## C. Reversibility & Safety

Approval gates are common. Real rollback plus an audit trail is not. The rule: never
promise an undo you cannot perform — describe the compensation instead.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| R1 | File checkpoints and `weaver undo` | `shipped` | Content-addressed, no git. Restores edits and deletes created files. |
| R2 | Undo files a shell command created | `shipped` | Set comparison when the sweep saw the whole tree; refuses to guess when truncated. |
| R3 | Non-file action journal | `shipped` | `core/safety/rollback.ts`; used by Arif Agent's publisher. Plan → commit/fail → compensate. |
| R4 | Sandbox detection and honest disclosure | `shipped` | Landlock/Seatbelt/WSL/none; absence is a first-class disclosure. |
| R5 | Real containment on every target | `partial` | Seatbelt prefix ships; Landlock/WSL are argv-only. Acceptance: shell tool supports argv mode. |
| R6 | Ordered permission rules (allow/ask/deny) | `partial` | Capability/provenance gate ships; no rule DSL. Acceptance: `permissions` list with last-match-wins. |
| R7 | Deployment rollback | `todo` | A deploy is a sequence: record the previous revision, the health check, and the revert command *before* deploying. |
| R8 | Immutable execution trace | `todo` | Append-only event log per turn, hash-chained. Acceptance: tampering is detectable. |
| R9 | Non-human identity / RBAC (Arif Agent teams) | `todo` | Service identity per engine, scoped credentials. Not needed for single-user local. |
| R10 | Multi-account identity selection | `shipped` | GitHub and Vercel adapters; explicit switch, modal confirmation, remembered per workspace. |

**Never:** an `--yes-i-mean-it` flag that bypasses the judge. The whole point is that the
agent cannot sign its own permission slip.

---

## D. Scope & Judgment

Most agents build exactly what is asked. The valuable ones say "this will break X" or
"there is a simpler way" **before** building.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| S1 | Deterministic scope pushback | `shipped` | `core/safety/scope.ts`: destructive scope, credential + outbound, dependency adds, bundled objectives. |
| S2 | Diff-vs-intent check | `todo` | Compare touched paths against the request. Acceptance: a one-line fix that edits 14 files is flagged. |
| S3 | "This will break X" | `todo` | Uses M5 lineage. Acceptance: a schema rename names the consumers before writing. |
| S4 | "There is a simpler way" | `todo` | One bounded suggestion, with the trade-off stated. Never a lecture. |
| S5 | Calibrated confidence | `shipped` | Evidence status, not introspection. `proved — 3/3 checks` is checkable; "80% sure" is not. |
| S6 | Urgency awareness | `todo` | Duet's documented weakness. Ask, do not infer; never treat shouting as authorisation. |
| S7 | Broader-change-than-requested detection | `partial` | Scope-creep heuristic ships; diff-scope measurement does not. |

---

## E. Durability of Long Tasks

Interrupt a long job and most agents lose the thread. The fix is not "more context"; it is
checkpoints, a summary that survives compaction, and a clean handoff.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| D1 | Sessions and resume | `shipped` | `--resume <id>`, session list. |
| D2 | Compaction | `shipped` | Structured summary + recent tail; language-tax-aware estimator; one retry on a too-long rejection. |
| D3 | Approval gates with pause/resume | `partial` | Canary blocks are gates, but there is no explicit "pause here, human decides, resume" state. |
| D4 | Handoff artifact | `partial` | Compaction summary + receipts + decisions exist; no single "pick this up" bundle. |
| D5 | Background / always-on tasks | `todo` | Dots-style. Needs the server (I4) and a scheduler; not before. |
| D6 | Crash recovery | `partial` | Checkpoints before mutation and torn-line repair ship; no resume-from-crash orchestrator. |
| D7 | Resumable provider calls | `todo` | Retry with backoff and a stable request id; never duplicate a side effect on retry. |

---

## F. Cost & Latency

Token prices fall; token *usage* rises 5–30x for agents. The hard part is not the meter —
it is that providers report usage inconsistently and tokenizers are not language-neutral.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| C1 | Real token usage metering | `todo` | Parse provider `usage` (streaming `include_usage` + non-streaming). Never present an estimate as a measurement. |
| C2 | Budget guard | `ready` | `core/routing` refuses when the ceiling is spent. |
| C3 | Cheapest-model routing | `ready` | Deterministic complexity score; no LLM call to choose the model. |
| C4 | Live cost meter | `todo` | Per-turn tokens + cost in the status bar; a `weaver cost` history. |
| C5 | Latency budgets | `partial` | Shell timeouts ship; provider calls have no deadline. |
| C6 | Local-currency display and prepaid caps | `todo` | Editable FX rate; hard stop at a prepaid ceiling; no auto-upgrade. |
| C7 | Cost preflight | `todo` | Estimate before a long turn, with a "continue / use cheap model / stop" choice. |

**Why C1 before C4:** a meter built on `chars/4` is wrong by up to 8.9x for N'Ko and 7.4x
for Amharic. A confident number that is wrong is worse than no number.

---

## G. Reach & Extensibility

Breadth is table stakes, not differentiation. Build it in the order that preserves the
gate: anything that reaches outward is `egress` and gated on provenance.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| E1 | Model freedom | `shipped` | 7 presets + custom base URL + Ollama; OpenAI-compatible dialect; no vendor lock. |
| E2 | MCP servers | `todo` | Tools declare capability/ingest at load. A server that cannot declare does not load. |
| E3 | Skills | `todo` | `.weaver/skills/<id>/SKILL.md`, loaded by the `skill` tool. |
| E4 | Subagents | `todo` | `explore`, `general`; child sessions inherit the gate and the receipt. |
| E5 | Commands and agent files | `todo` | Markdown agents, slash commands, `AGENTS.md` instructions. |
| E6 | `patch` (multi-file atomic edit) | `todo` | Add/update/delete/move with one receipt and one checkpoint. |
| E7 | `webfetch` / `websearch` | `todo` | Always `ingest: "external"`; fetched content taints downstream egress. |
| E8 | Browser control | `hold` | Antigravity-class artifacts (screenshots, recordings). Blocked on R5 real containment. |
| E9 | No-API app control (Grok's idea) | `hold` | Logging in as a person and clicking is a security decision, not a feature. Needs a sandbox, a consent model, and a policy answer for Android Play. |
| E10 | Plugins | `hold` | Must declare capability/ingest or they bypass the trust layer. |
| E11 | LSP diagnostics and formatters | `todo` | Diagnostics after edit; format on write. |
| E12 | Attachments (images, PDFs) | `todo` | Priced and size-capped; never silently uploaded. |

---

## H. Interfaces & Coordination

The terminal is the first interface, not the only one. A server is what makes desktop,
web, and multi-agent possible.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| I1 | TUI | `shipped` | Hand-rolled ANSI, no dependencies, degrades to REPL. |
| I2 | Plain REPL | `shipped` | Works without a TTY. |
| I3 | CLI verbs | `shipped` | setup, providers, models, config, auth, sessions, checkpoints, undo, decisions, verify, receipts. |
| I4 | HTTP server + API + client | `todo` | TUI and headless `weaver run` both sit on it. Acceptance: a session can be driven over HTTP. |
| I5 | Desktop / web | `todo` | Only after I4. |
| I6 | Shared blackboard for multiple agents | `todo` | Live state of intent, assumptions, blockers. **Blocked on M5**: without lineage it just makes collisions faster. |
| I7 | Cross-agent conflict detection | `todo` | Two agents touching the same contract must see each other before they write. |
| I8 | ACP / editor integration | `todo` | Editors are where developers already are. |
| I9 | External CLI integrations | `shipped` | `core/integrations`: GitHub + Vercel, manifest adapter for other CLIs. |
| I10 | Overlay layer and command palette | `shipped` | Centered panel over a dimmed frame; used by the account switcher and the `:` palette. |

---

## I. African Realities

This is not a corporate-social-responsibility section. It is an engineering constraint, and
it changes the design.

The numbers, as of late 2026:

- **Bandwidth is expensive.** Sub-Saharan Africa is the fourth-most-expensive region for
  mobile data, averaging roughly **$2.42/GB**; a 5 GB basket exceeds **10% of monthly
  income** in some countries. Mobile traffic per smartphone is about **5 GB/month**, versus
  **19 GB** globally.
- **Power is unreliable.** Unmitigated outage costs run **$2–$32 per kWh**; firms lose
  roughly **5% of sales**. Diesel self-generation is the default workaround.
- **Devices are modest.** Android is roughly **82%** of mobile OS share; smartphone
  penetration in SSA is below **50%**, with a large low-RAM installed base.
- **Language costs more.** The same meaning costs a median **1.88x** more tokens on GPT-5's
  tokenizer for African languages, **7.4x** for Amharic, and **8.92x** for N'Ko — as little
  as **11%** of English's effective context window. Only about **42** African languages
  have meaningful LLM support.
- **Mobile policy blocks autonomy.** Google Play prohibits autonomous Accessibility API
  use; a Play-distributed agent cannot self-drive apps. Sideloading via Termux/Shizuku is a
  different product with a different story.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| A1 | Power-loss safety | `partial` | Torn-line repair and pre-mutation checkpoints are tested. Next: a real `kill -9` crash test and an explicit `fsync` policy. |
| A2 | Metered-bandwidth mode | `partial` | Compaction and no telemetry ship; no explicit `--offline`. |
| A3 | Prepaid caps and local currency | `todo` | Hard stop, no auto-upgrade, editable FX. Acceptance: a 100 KES cap stops the run. |
| A4 | Language-tax-aware budgeting | `shipped` | Estimator charges non-Latin codepoints 1.7x; compaction uses it. |
| A5 | Multilingual UI and prompts | `todo` | Match the user's language; plain-language mode; test corpus in Swahili, Hausa, Yoruba, Amharic. |
| A6 | Wide-script terminal rendering | `todo` | Ge'ez, N'Ko, CJK width handling in the TUI. Acceptance: no broken borders. |
| A7 | Intermittent connectivity | `todo` | Retry with backoff, resumable turns, a degraded mode that still edits files and undoes them. |
| A8 | Low-spec devices | `partial` | Zero deps and small context help; no RAM-aware model suggestion or startup budget. |
| A9 | Android path | `hold` | Termux/Shizuku sideload, scoped storage, foreground-service limits, thermal/battery. Blocked on A8. |
| A10 | No card, no account | `shipped` | Keyless free provider by default; no mandatory login. |
| A11 | Device lifecycle | `partial` | Checkpoint rotation bounds disk; no explicit "works on a 2019 phone" test. |
| A12 | Cheap updates | `partial` | No bundled models, no postinstall; no delta-update story yet. |
| A13 | Offline-first verification | `todo` | Checks that do not need the network; when they do, say so instead of failing mysteriously. |

**Design consequences already in the code:** the tokenizer-aware estimator, the honest
"unproven" status, the content-addressed checkpoint store (git is unusably slow on modest
hardware), and the refusal to require a cloud account.

---

## J. Self-Dependence

Self-dependence means: runs without an account, without a cloud, without a network, and
without a dependency tree that can be pulled out from under it. It is a product property,
not a deployment option.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| SD1 | Zero runtime dependencies | `shipped` | Node builtins only; TypeScript run directly by Node 24. |
| SD2 | No mandatory account or cloud | `shipped` | Works keyless out of the box. |
| SD3 | Local, plain-file data | `shipped` | Sessions, decisions, receipts, checkpoints are JSON/JSONL/Markdown. |
| SD4 | Model freedom | `shipped` | Any OpenAI-compatible endpoint; no vendor lock-in. |
| SD5 | Offline core | `partial` | Edit, undo, verify, receipts work offline; the agent loop needs a model. |
| SD6 | Self-hosted sync | `shipped` | Arif Agent's daemon; no SaaS in the loop. |
| SD7 | Repairability | `partial` | No build step, readable source; no `weaver doctor` yet. |
| SD8 | Export everything | `todo` | One command produces a portable archive of sessions, decisions, receipts. |
| SD9 | No postinstall, no native modules | `shipped` | Nothing runs at install time. |
| SD10 | Pinned engine | `shipped` | Vendored Canary, hash-pinned, never edited. |
| SD11 | Local model manager | `todo` | Surface Ollama models, RAM fit, and context size; never download silently. |
| SD12 | Graceful degradation matrix | `todo` | Document and test every mode: model only, no network, no git, no Python, low disk. |
| SD13 | Hardware-aware onboarding | `shipped` | Detects RAM/disk/admin, recommends the largest model that fits, offers an Ollama pull, never defaults to full access. |
| SD14 | Single safe base workspace | `shipped` | Setup writes `~/.weaver/workspace`; `-C` opts into another directory. |

**Never:** telemetry, a required login, a "cloud-only" feature that makes the local
product worse, or a memory format that cannot be read with `cat`.

---

## K. Arif Agent — the multi-axis sibling

Arif Agent inherits `core/` and `engines/coding/` from Weaver; it owns growth and business
operations. The rule is inheritance by sync, never a fork.

| ID | Item | Status | Next step / acceptance |
| --- | --- | --- | --- |
| AR1 | Sibling project + conflict-aware sync | `shipped` | `sync-daemon.py`; refuses to overwrite downstream edits. |
| AR2 | Growth tools | `shipped` | Analytics summary, local queue, gated publish with compensation. |
| AR3 | BizOps tools | `shipped` | Invoice drafts in integer cents with local dates; CRM outbox. |
| AR4 | Arif Agent's own loop and UI | `partial` | Dashboard and CLI shipped. The LLM loop still needs extracting into `core/`; do not copy `src/`. |
| AR5 | Compensation before external effects | `shipped` | Publish plans the delete before posting; duplicate sends refused. |
| AR6 | Multi-axis blackboard | `todo` | Same dependency on M5 as I6. |
| AR7 | Mobile-money and invoice rails | `todo` | M-Pesa/Flutterwave-style adapters are `egress`; drafts by default. |
| AR8 | Arif Agent dashboard (TUI + CLI) | `shipped` | Rail, pane, command line, footer; pure renderer with an exact-width test and a headless smoke. |

---

## Milestones

| Version | Theme | Ship | Acceptance |
| --- | --- | --- | --- |
| **v0.8** | Cost & Connection | C1, C2, C3, C4, C6, A3, A7, SD5, SD7 | A turn shows real tokens and cost; a prepaid cap stops the run; `--offline` edits and undoes without a network. |
| **v0.9** | Reach | E6, E7, E3, E4, E11, M2 | `patch` is atomic; web fetch is egress-gated; a skill loads; a subagent returns a receipt. |
| **v1.0** | Proof & Platform | I4, M4, M5, M6, S2, S3, R7, P6, P8 | A server drives a session; a spec invariant has a check; a schema rename warns about consumers; a deploy can be reverted. |
| **v1.1** | Coordination | I6, I7, AR4, AR6 | Two agents share a blackboard and detect a conflicting assumption before writing. |
| **v2.0** | Learn & Act | E8, E9, A9, A11 | Sandboxed no-API control with recorded artifacts, explicit consent, and a documented Play-policy position. |

---

## Anti-goals

These are listed so they do not get added by accident:

- **Default `* allow` permissions.** OpenCode's thesis, not ours.
- **A model-reported confidence percentage.** It is an assertion, not calibration.
- **Memory the user cannot inspect, edit, or export.**
- **Telemetry, or a required account/cloud.**
- **Silent sandbox claims.** If there is no fence, say so.
- **Auto-publish, auto-send, or auto-deploy without consent.**
- **Calling a compensation an "undo."**
- **Vendor-locked models.**
- **US-first assumptions** baked into defaults, dates, currencies, or connectivity.
- **Plugins that assert their own permissions** without declaring capability and provenance.

---

## Open questions

1. **First African language corpus:** Swahili, Hausa, Yoruba, Amharic, or all four? This
   sets the tokenizer and UI tests.
2. **Mobile target:** Termux/Shizuku sideload, a dedicated Android app outside Play, or
   both? The policy answer differs.
3. **Local model baseline:** 3B on 4 GB, 7B on 8 GB, or a tiered recommendation?
4. **Cost data:** accept provider-reported usage only, or allow a user-supplied price
   table for providers that do not report?
5. **Arif Agent's first real adapter:** X, LinkedIn, WhatsApp Business, or a generic webhook?
6. **Spec engine format:** Markdown with fenced checks, or YAML? Markdown is more likely
   to be read by humans; YAML is easier to validate.

---

## Evidence appendix

Numbers used above, with their shape and vintage. Treat them as directional, not gospel.

| Claim | Source shape |
| --- | --- |
| Median 1.88x token premium (GPT-5/o200k), 7.4x Amharic, 8.92x N'Ko, 11% effective context | arXiv:2606.24460, *The African Language Tax*, Jun 2026 |
| Gemma 4 reduces mean premium to 2.38x; no tokenizer eliminates it | Same paper |
| SSA average ~$2.42/GB; 4th most expensive region | Mobile-data price survey, 2026 |
| 5 GB basket >10% of income in some LMICs | ITU Global Connectivity Report, 2025 |
| 5 GB/month per smartphone vs 19 GB global | MDPI / GSMA-cited analysis, 2024–2026 |
| Outage cost $2–$32/kWh; ~5% of sales lost | Energy for Growth Hub; Energy Transition Africa |
| Android ~82% mobile OS share in Africa | StatCounter, Jul 2026 |
| Smartphone penetration <50% in SSA | Industry estimate, 2025 |
| ~42 African languages with meaningful LLM support | 2025 review cited by DataLens Africa |
| Play prohibits autonomous Accessibility API use | Google Play policy |

---

## Changelog

| Date | Version | Change |
| --- | --- | --- |
| 2026-11-04 | v0.7.0 | Roadmap created. Proof receipts, self-authored detection, evidence statuses added to A. Cost, lineage, reach, African realities, and self-dependence tracked as the next frontier. |
| 2026-11-04 | Arif Agent v0.2.0 | Arif Agent dashboard and CLI shipped. Shared terminal primitives (`ansi`, `keys`, `box`, `canvas`) moved into `core/tui` and inherited through the sync. |
| 2026-11-05 | Arif Agent v0.2.1 | GitHub/Vercel integrations with multi-account selection; overlay layer and `:` command palette; styled spans, syntax-highlighted code cards, and account-switch modal. |
| 2026-11-05 | Onboarding | `weaver setup` detects CPU/RAM/disk/admin, recommends the largest local model that fits, offers an Ollama pull, and writes the safe base workspace. |
