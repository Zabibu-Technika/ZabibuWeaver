# The edge — what actually makes Weaver different

Written down because it is easy to lose. Every coding agent has a terminal UI, tools,
sessions, and a permission prompt. If Weaver is judged on that list it loses, because
opencode, Claude Code and Codex all have teams, funding and distribution behind their
version of that list.

So this is the determination, and the rule that follows from it.

---

## In one sentence

> **Weaver is the only coding agent whose work is graded by an independent, deterministic
> judge — and shipped with a receipt a stranger can verify, without trusting the agent,
> the model vendor, or Weaver.**

Everything else Weaver does is table stakes. This is the thing nobody else ships.

---

## The four differences, ordered by how hard they are to copy

### 1. The judge is vendored, pinned, and hash-verified — not imported from a sibling — *the moat*

Every other harness gates **actions**: *may I run this command?* Weaver gates actions
**and outcomes**: *was the result acceptable?*

That outcome gate is `packages/engine` — the same code behind the Canary web app, the
Canary CLI, and Weaver. One rule set, three front doors. A review is identified by
`sha256(diff)` truncated to 16 hex characters, so the id the agent prints, the id the CLI
prints, and the id the web app prints are **provably about the same change**. The approval
lands in `~/.zabibucanary/ledger.jsonl`. A `critical` finding without a matching entry in
that ledger does not produce a warning — it produces **BLOCKED**.

Until recently Weaver *reached for* a sibling `zabibu-canary` checkout and imported it. That
was co-location, not integration: it made Weaver depend on where a second project happened
to live, and it broke the moment Weaver was cloned anywhere else. So the engine is now a
**byte-for-byte copy** in `src/engine/`, pinned by `provenance.json` to an upstream commit
and a sha256 per file. Two tests enforce it: one recomputes those hashes on every run, so
the copy cannot be edited without a test failing; the other compares it against upstream
when upstream is present, and fails the moment Canary's engine moves.

Embedding it did not weaken the claim — it strengthened it, because three properties survive
intact and one is now stronger:

- **Independent, in the way that matters.** Weaver no longer touches the sibling at all, so
  the judge cannot be quietly edited by someone standing next to it. Provenance pinning
  replaces proximity: a claim is only as good as its evidence, and this one comes with a
  hash.
- **Deterministic** (below) — and the property that makes the first one worth anything.
- **Reproducible across the boundary.** The engine imports nothing but itself, reads no
  files, touches no env, makes no network calls. It is a pure function of the diff, so
  Weaver and a Canary CLI half a world apart compute the *same* analysis id. That is what
  makes a receipt verifiable by a stranger.
- **Deliberately incomplete.** The signing half, `ledger.ts`, is *not* vendored. Weaver
  embeds the judge, not the pen: it can read the approval ledger and be blocked by it, but
  it cannot generate a key or write a receipt. An agent that could sign its own permission
  slip would not be governed — it would be asked nicely.

Nobody in this category ships a separate judging engine whose verdicts you can reproduce
on a machine the agent never touched.

### 2. The judge is deterministic — it cannot be argued with

This is the property that makes #1 worth anything, and it is verifiable: the engine
contains **no network calls and no LLM references**. It is roughly 13 KB of rules.

Why that matters, concretely:

- An **LLM reviewer can be prompt-injected by the very diff it is reading.** Code under
  review is attacker-controlled text. A regex cannot be talked into a different verdict.
- A deterministic judge is **reproducible**: same diff → same id → same verdict, on any
  machine, this year or in five. No temperature, no version skew, no vendor deciding to
  retire the model (a failure mode this project has already been bitten by, elsewhere).
- The verdict is **portable**. It is not "Claude thought it was fine." It is a file whose
  hash you can recompute yourself.

### 3. It runs on nothing — *the onboarding advantage*

Zero runtime dependencies. No build step. `node src/index.ts`, Node 22.18+.

- No account, no key: if nothing is configured, Weaver starts on a free keyless endpoint.
- The whole agent is a few thousand lines you can read in an afternoon.

For a product whose pitch is *you can verify what it did*, **auditability is the feature.**
You cannot ask someone to trust a gate they are not allowed to read.

### 4. It drives endpoints other harnesses refuse — *the portability advantage*

Many free endpoints ignore the `tools` parameter. Most harnesses respond "this model
doesn't support tools" and stop. Weaver teaches the model a textual protocol in the system
prompt —

```
<function=read_file>{"path": "src/index.ts"}</function>
```

— and reads it back with the same balanced-JSON salvage parser that heals malformed tool
calls. That parser also recovers the intended call out of Groq's `failed_generation` field
*before* the error is surfaced. Which brings us to the origin:

> This project began as a skeleton that regex-scraped a tool call **out of an error
> string**. That wound is now a supported code path, and the reason a tool-less free
> endpoint can drive a real agent loop.

---

## What is *not* the edge

Saying this out loud keeps the roadmap honest.

| Not the edge | Why |
| --- | --- |
| The TUI | Every harness has one. Ours is pleasant and dependency-free; it is not a reason to switch. |
| Free providers | Excellent onboarding, trivially copied, and not a moat of any kind. |
| Tool speed, streaming, sessions | Table stakes. Parity, not advantage. |
| Anything described as "opencode, but with X" | If X can be a config flag in opencode tomorrow, it is not an edge. |

The wedge is **trust**, and trust is only worth something when the thing being trusted is
independent, deterministic, and checkable.

---

## The hole in the moat — fix this before adding features

**Untracked files are not covered by the sign-off.**

`git diff` cannot see untracked files, and Weaver deliberately does not stage them,
because staging changes the diff hash and would break receipt matching with the Canary
CLI. So the current behaviour is to *warn*:

```
1 untracked file(s) not covered: mock.json
git diff cannot see new files — stage them to bring them into the sign-off.
```

That warning is honest, and it is **not a gate**. Concretely: an agent can create
`deploy.sh`, put a live API key in it, and the sign-off will not block it. That is a
direct attack on the one claim that matters.

This is the most valuable thing on the roadmap, and it is not a feature — it is a repair.
It needs a Canary-side change: extend the diff and the `analysisId` definition to include
the contents of untracked files, so the agent and the CLI hash to the same id.

---

## The test for every new feature

Three questions, in this order:

1. **Does it make the sign-off stricter or more complete?**
   → Build first. This is the moat. Nothing outranks it.
2. **Does it make the agent easier to audit, or run on less?**
   → Build if it is cheap. Keeps the trust claim structurally true.
3. **Is it parity with opencode / Claude Code / Codex?**
   → Adopt the *cheap* version, defer the expensive one, and never let it be the reason
   someone picks Weaver.

Applied to the "add the best features from every harness" request — now informed by
[COMPETITORS.md](COMPETITORS.md), which swept the field in October 2026:

| Feature | Verdict | Reasoning |
| --- | --- | --- |
| Cover untracked files in the sign-off | **Do first** | Repairs the moat. Question 1. |
| **Fail-closed judge** | **Done (v0.3.1)** | If the judge errors, the turn must BLOCK. A judge that fails open is worse than no judge. Implemented: unloadable engine, unloadable override, or a judge that throws while analysing all return a blocked report with the reason attached; the loop's own catch surfaces anything unexpected instead of swallowing it. |
| **Fix-verify loop** | **Done (v0.4.0)** | Re-run the judge after the agent fixes a finding, and close it. From Greptile's `/greploop`. Small, big UX win. Implemented with three guards: a failing judge is never handed to the model, the pass count is capped, and an unchanged analysis id stops the loop. |
| Context compaction | **Do** | The biggest functional gap — every serious competitor has it, and after compaction re-injects the project memory file and the five most recently edited files. Without it, long sessions die. |
| Doom-loop detection | **Do** | opencode asks when the same tool call repeats 3× with identical input. One rule, prevents an embarrassing failure. |
| Checkpoints / undo | **Do** | Gemini CLI and Cline both have it; Weaver has no way to take back a bad turn. |
| **Plain-language overlay** | **Do** | A plain sentence in front of every diff, error and permission prompt. Cheap, and it unlocks the non-developer market. |
| Override with a named reason | **Do** | CodeRabbit records who overrode. Makes `critical` findings survivable without gutting the gate. |
| Sub-agents | **Do, but gated** | Every sub-agent's writes pass the *same* permission gate, and there is still **one** sign-off at the end of the turn. The interesting version is "autonomy the moat makes safe" — not a copy of someone else's sub-agents. |
| Cross-session memory | **Defer** | Claude Code's auto memory is genuinely good, but it writes notes the agent chose to write. That is a trust problem: the governed party keeping its own records. Think hard before copying. |
| Parallel tool calls | **Do** | Cheap, and reads and writes must still be ordered behind the gate. |
| LSP diagnostics | **Adopt cheap version** | Parity. Valuable, but not differentiating; do not over-invest. |
| Graph index | **Defer** | The honest answer to "we only see the diff", but a big build. |
| Plugin API | **Defer** | Parity, expensive, *and* it is a supply-chain surface — which cuts directly against the auditability claim. A plugin can do anything; that is the opposite of a readable gate. |

Notice the shape: **autonomy features are only safe to add here because of the moat.**
Sub-agents in a harness without an independent judge are a liability. In Weaver they are
the point.

---

## How to prove it in sixty seconds

Do not argue the pitch. Run it:

```bash
npm run smoke:canary
```

It writes a file containing a hardcoded secret, runs the real loop, calls the real engine,
and asserts the turn comes back **BLOCKED**. Then look at `~/.zabibucanary/ledger.jsonl`,
recompute `sha256` of the diff, and confirm the id matches. Nothing in that chain requires
trusting Weaver.

That is the demo. Everything else is a terminal UI.

---

— Zabibu Technika · Tehillah Kachila
