# Brief for an external reviewer: Weaver + Canary

*Paste this whole document. It is written for a reviewer with no prior context, and it is
deliberately not flattering. Where our knowledge is stale or uncertain it says so and asks
you to verify. Where we have made a decision, it explains the reasoning so you can attack
the reasoning rather than the conclusion.*

---

## 1. Who we are and what we are building

**Zabibu Technika.** Two products, one thesis.

**Canary** — a deterministic code-review engine. It takes a diff and returns a verdict:
risk score, grade, findings by sector, and an `analysisId` which is `sha256(diff)` truncated
to 16 hex chars. No LLM, no network, no temperature. The same diff on two machines produces
the same id, so a receipt is verifiable by a stranger. A separate CLI writes signed
receipts into `~/.zabibucanary/ledger.jsonl`.

**Weaver** — an open-source, local-first coding agent that competes with OpenCode,
Claude Code, Codex CLI and friends. TypeScript executed directly by Node 24, no build
step, **zero runtime dependencies**. It has a TUI, free keyless providers out of the box,
a permission gate, sessions, and — the wedge — **every change it makes is judged by
Canary after the fact and gated by a signed approval.**

The claim we are staking:

> The only coding agent whose work is graded by an independent, deterministic judge,
> shipped with a receipt a stranger can verify.

The engine is **vendored into Weaver** as a byte-for-byte, hash-pinned copy pinned to an
upstream commit, with a per-file sha256 in `provenance.json`. We deliberately do **not**
vendor the signing half (`ledger.ts`). Weaver embeds the judge, not the pen: it can read
the approval ledger and be blocked by it, but it cannot generate a key or write a receipt.
An agent that can sign its own permission slip is not being governed, it is being asked
nicely.

### The pivot that motivates this conversation

Everything above is developer-shaped. We are now pivoting to **non-developers** as the
primary market: people who want to run their own coding agent, *system* agent, or
*computer* agent on their own machine. The reference point for that product category is
**OpenClaw** (formerly Moltbot / Clawdbot) — and OpenClaw is also our reference point for
what must not happen again.

**Current state: 94 tests passing, all smoke tests green.** But be sceptical of that
number; see §7 for what is *not* built.

---

## 2. The threat model we designed against

We did substantial research into OpenClaw's real failure record before writing security
code. We are not certain we have it right, and §6 asks you to attack it.

**The lethal trifecta** (Palo Alto Networks Jan 2026, IBM X-Force Apr 2026): OpenClaw had
(1) deep access to private local data, (2) interaction with untrusted external content,
(3) the ability to communicate outward. Any two are survivable. All three is an
exfiltration machine.

**Specific incidents we designed around:**

- **CVE-2026-25253** — read a `gatewayUrl` out of a query string, automatically opened a
  WebSocket **without prompting**, sent a token with it. One-click RCE. CWE-669.
- **"ClawJacked"** (Oasis Security) — malicious websites hijacked locally running
  instances and silently exfiltrated data using the agent's own autonomy.
- **Varonis phishing simulation** (June 2026) — an OpenClaw email agent leaked AWS
  credentials, database passwords and customer data. It granted access **because the
  request felt urgent.** Urgency is persuasion aimed at a human; it worked on the agent.
- **Radware "ZombieAgent"** (Jan 2026) — persistent memory as an injection channel. An
  instruction that reaches long-term memory outlives the input that carried it and becomes
  a standing insider.
- **Backslash** (June 2026) — an agent configured for a narrow, low-risk use case had far
  broader effective privileges than its configuration implied.

**The architectural finding that shaped everything:**

> From the Cloud Security Alliance's June 2026 review, following OpenAI's Lockdown Mode
> announcement: *"the long-term defense posture is architectural, not behavioral… the
> language model cannot reliably distinguish operator instructions from content it is
> processing, and defense must therefore be located **outside the model**."*

**And the sharpest thing we found — OpenClaw's own published security policy**, which
states that the following are *not* security vulnerabilities by themselves:

> - Prompt injection without a policy, auth, approval, sandbox, or tool-boundary bypass.
> - Malicious behavior in a plugin installed or enabled by a trusted operator.

We think that policy is coherent and defensible for a developer running a personal
assistant. We think it is indefensible for a product whose users cannot reliably tell a
phishing email from a real one. That is the line we are drawing.

---

## 3. What we have already built (so you can critique the decisions, not the inventory)

These are real, tested decisions. Attack the reasoning.

### 3.1 The sign-off fails closed

If the judge cannot load, or throws while analysing, Weaver returns a **blocked** report
with the reason — never a clean pass and never an exception. Semgrep's rule: an internal
error must never register as a pass, because the alternative is a gate that silently stops
working and nobody notices it is off. An explicit engine override that points somewhere
unusable fails closed too, and does **not** silently fall back to the embedded copy.

### 3.2 The fix-verify loop

When the judge blocks, the findings are handed back to the model for one bounded repair
pass, then the judge runs again. Guards: a failing judge is never handed to the model; the
pass count is capped; an unchanged `analysisId` stops the loop. The brief tells the model
explicitly that it cannot approve its own work, that deleting or neutering the check is
not a fix, and that a false positive should be raised rather than routed around.

### 3.3 Trust boundaries (`src/trust/taint.ts`)

Every piece of content is labelled **where it entered**:
- `user` — typed by the human this session. Trusted.
- `local` — from their own machine at their direction. Semi-trusted.
- `external` — web, email, messages, skills. Untrusted.

Every tool declares a capability: `read`, `local-write`, `destructive`, `egress`, or
`unbounded` (shell, which is all of them).

> **The rule:** a high-risk call influenced by untrusted content requires consent, every
> time, with **no "always allow" available.**

Taint is tracked at two levels, deliberately:
- **Value-level** — the external string appears verbatim in the arguments. A *filter*, not
  a guarantee, because the model paraphrases on every step.
- **Context-level** — this turn ingested *anything* external, so outward calls are treated
  as influenced. This is the *guarantee*. Coarser, costs extra clicks.

**Our position:** the cost of being conservative is a click; the cost of being permissive
is a credential.

Instruction-shaped text in untrusted content is **disclosed** to the user, and disclosure
survives `--permission full`, because telling the user what happened costs nothing while
hiding it behind a verbosity flag is OpenClaw with better manners.

### 3.4 Profiles (`src/onboard/profiles.ts`)

One dial, five positions: `explorer` (never opened a terminal) → `general` → `power` →
`developer` → `expert` ("ponytail-style" developer wanting correction, conversation,
verification). Each presets permission mode, whether to ask before edits, toolset offered,
verbosity, and repair passes.

**The trap we are most worried about:** treating "security safeguards" as another notch on
the dial so an expert gets a looser gate. The Varonis simulation tricked *the agent*, not
a beginner — skill level was irrelevant to whether the secrets went out. So the dial
controls friction, exposure and verbosity; the trust boundaries are `INVARIANTS`, not
fields on any profile, and a test fails if a bypass-shaped field is ever added.

### 3.5 The knowledge graph (`src/memory/graph.ts`)

A local memory of what the user's words refer to, so "the dashboard" resolves in O(1)
instead of a grep plus six files in context. Measured in our tests: **~180 tokens against
~4,000** for the same twelve ambiguous references — a 20x reduction, bounded by
construction so it does not grow with the project.

Built **on** the trust layer, not beside it: only `user`-confirmed entries are
authoritative; untrusted-derived entries are marked `unverified` and never auto-applied;
the human's **reject list** (references they called wrong or irrelevant) cannot be
overridden by inference. The reject list is also where the token saving comes from.

### 3.6 Known holes we have documented

- **Untracked files are not covered by the sign-off.** `git diff` cannot see them and
  Weaver will not stage them (staging changes the diff hash and breaks receipt matching).
  An agent could create `deploy.sh` with a live API key and the sign-off would only warn.
  This needs a coordinated change on the Canary side.
- **Not a sandbox.** Nothing here contains a malicious binary. The sign-off catches bad
  changes after the fact; the trust layer catches manipulation before. Neither replaces
  OS-level isolation, which we do not ship.
- **Consent fatigue is a real attack.** If everything asks, users learn to type "yes".
  We kept the consent rule narrow for that reason.

---

## 4. What our principal wants (and where we are unsure)

Our founder's requirements, in his words, paraphrased:

1. **Normies must be able to use it.** The whole point is enabling someone who does not
   want to do a bunch of coding to run their own coding agent, system agent, or computer
   agent — with the reach of OpenClaw but not the danger.
2. **Confirm that what the user wrote is what they wrote** — so no hidden instructions go
   through.
3. **Confirm the user wants to code** and set itself up for code; **know when to enter
   normal mode**; know when to use the tools.
4. **An extensive tool set for any kind of system:** Apple (macOS, iOS, iPadOS, watchOS),
   **Zabibu OS** (our own operating system), Windows, Linux (most or all major
   distributions), Android and its major offshoots.
5. **Onboarding** that knows which kind of user it is dealing with, with presets for how
   involved the human-in-the-loop should be — trust, capability, safeguards — across the
   whole range from absolute normie to expert developer.
6. **An internal knowledge graph** that updates over time, learns the user, adapts to what
   they know, and maintains **rejections of incorrect or irrelevant references** — so that
   when a human (especially someone with ADHD, who references many things) mentions
   something, the system retrieves it fast and the context window stays small by default.
   Less token consumption, less power and energy, no unnecessary token maxing.
7. **Human in the loop where needed, automation where not.**

---

## 5. What we want you to look up

Please verify current state on all of these. Our knowledge has a cutoff and this field
moves weekly. Where we have stated something as fact in §2 or §3, tell us if it is now
wrong, superseded, or contested.

**Safety architecture**
- Current version of the **OWASP Top 10 for Agentic Applications**, and how our controls
  map to it. Anything we are missing entirely?
- **MITRE ATT&CK T1700** (AI-enabled exfiltration) and **ATLAS** — current mitigations.
- **OpenAI Lockdown Mode and Elevated Risk labels** — what shipped, what it actually
  enforces, and whether the "architectural not behavioral" claim has held up.
- **Anthropic's** published work on prompt-injection resilience and computer-use
  sandboxing. What did they conclude is defensible?
- **Google's Agent Payments Protocol (AP2)** and agent identity/attestation efforts — is
  there an emerging standard for "an agent did this, and here is proof"?
- **MCP (Model Context Protocol)** security — the confused-deputy problem, tool
  poisoning, and whether MCP is a net risk for a product like ours.

**Isolation and sandboxing (we ship none)**
- Practical, cross-platform sandboxing for an agent process: **Landlock** (Linux),
  **Bubblewrap**, macOS **sandbox-exec** / Seatbelt, Windows **AppContainer** and
  restricted tokens. What is actually shippable in a zero-dependency Node CLI today?
- Browser isolation for agent-driven browsing.
- Whether Apple's platform allows any of this at all (see §6, question Q12).

**Context engineering and memory**
- State of the art and measured results: **Letta/MemGPT, Mem0, Zep/Graphiti, LangMem,
  Supermemory**. How do they handle provenance and poisoning? Is anyone gating
  memory writes on trust?
- **Context compaction / summarisation** practices in shipped agents — what gets
  re-injected, and what do they drop?
- Any **measured** numbers for tokens-per-task, cost-per-task, or **energy-per-task** for
  coding agents. We want real measurements, not marketing.

**Competitive landscape — please build current comparisons**
- Open source: **OpenClaw, OpenCode, Aider, OpenHands, Goose (Block), Cline, SWE-agent,
  AutoGPT, LangGraph, CrewAI, AutoGen, smolagents, OpenInterpreter, Continue, Zed agent,
  Codex CLI, Gemini CLI, Tabby**.
- Proprietary: **Claude Code, Codex/ChatGPT, Cursor, Windsurf, Devin, GitHub Copilot
  coding agent, Amazon Q Developer, Jules, Replit Agent, ChatGPT Agent/Operator, Factory,
  Reflection, Zencoder**.
- Post-PR review market: **CodeRabbit, Greptile, Bugbot, Qodo, Ellipsis, Graphite,
  Codacy (incl. Verity), SonarQube, Semgrep, Snyk Code, CodeQL**.
- On-device / mobile agents: what actually ships on **iOS, iPadOS, watchOS, Android**
  today — App Intents, Android/Agent spheres, on-device Gemma, and what an agent is
  permitted to do on each.

**Human-in-the-loop UX**
- Evidence on **consent fatigue** — rates at which users approve prompts, and what makes a
  confirmation still meaningful.
- Best-practice patterns for "explain what you are about to do in plain language" in
  shipped consumer agents.

---

## 6. The questions we most want answered

Please be adversarial. We would rather be told we are wrong now than ship something that
is.

**Q1 — Is deterministic review a dead end?** Canary is rule-based and shallow. It catches
hardcoded credentials, risky patterns, infra and manifest changes. It will never catch
"this logic is subtly wrong." Is a shallow-but-reproducible judge worth having as the
*gate*, with LLM review as a second opinion? Or are we shipping a lock that only stops
people who don't pick it?

**Q2 — Where is our threat model wrong?** Assume our trust layer is as described. Find the
attack that gets through. Specifically consider: multi-turn manipulation across turns
(we reset trust per turn — is that too coarse, or not coarse enough?), tool-output that is
itself the exfiltration channel, and anything that turns our own consent prompt into the
attack surface.

**Q3 — Is context-level taint too conservative to ship?** We cannot measure consent
fatigue without shipping. What is the observed approval rate in comparable products, and
what threshold turns a safety feature into a habit users click through?

**Q4 — Vendored engine: right call or wrong?** We vendored a byte-for-byte copy pinned by
hash rather than calling a remote service or the sibling repo. Advantages: reproducible,
offline, no supply chain at runtime. Disadvantages: stale, and we cannot push a fix
instantly. Is a locally-attested *remote* judge better for a security product? What do
people actually trust?

**Q5 — Is "receipt a stranger can verify" a real buying argument?** Our whole wedge rests
on it. Has any comparable claim succeeded commercially? Who is the buyer that cares?

**Q6 — Where are we over-engineered?** Be specific. We suspect the fix-verify loop and the
profile dial are the two places where we may have built complexity nobody asked for.

**Q7 — What is the actual cost of a coding agent?** Tokens per meaningful task, in the
real world, across the models we might default to. Our memory graph claims a 20x reduction
on context injection — is the framing honest, or is it measuring against a strawman?

**Q8 — For non-developers specifically:** what do they *actually* use agents for, with
evidence? Our working assumption is "run my apps, fix my files, handle my accounts, do the
boring computer things." Is that right, and is the willingness-to-pay real?

**Q9 — Onboarding:** is a deterministic classifier the right call, or should the model
propose the profile and the human confirm? We chose deterministic because a permission
level should not be a probabilistic guess — but is that too rigid?

**Q10 — The cross-platform vision.** What can an agent *actually* do on each of macOS,
iOS, iPadOS, watchOS, Windows, Linux (which distros?), Android and its offshoots, and our
own Zabibu OS? Where does the platform simply refuse to allow it? Please be specific about
what is possible today versus aspirational.

**Q11 — What are we missing that is now table stakes?** Anything a competent competitor
shipped in the last two quarters that we have no answer for.

**Q12 — Apple, specifically.** Our founder wants macOS/iOS/iPadOS/watchOS in scope. Given
App Sandbox, TCC, no background agents, no shell, and no sideloading on iOS — is this
vision achievable on Apple platforms at all, and what would an acceptable version of it
look like? Is watchOS even a coherent target?

**Q13 — Steelman the failure.** Write the most convincing case you can that Weaver fails.
Not a risk register — the specific story of how it loses to a competitor, or how it ships
and nobody cares.

---

## 7. What is NOT built (please do not assume otherwise)

This matters, because advice premised on the wrong inventory is worse than no advice.

- **No cross-platform computer tools at all.** No macOS, Windows, Linux, Android, iOS or
  Zabibu OS commands exist yet. The capability *registry* exists with real OS detection;
  the tools do not.
- **The knowledge graph is not wired into the agent loop.** It is implemented and tested
  but inert — nothing injects its context yet.
- **Onboarding classifies but there is no interactive flow** in the CLI or TUI yet.
- **No sandboxing.**
- **No plugin/skill system** — deliberately, because of the supply-chain vector.
- **No LSP, no sub-agents, no true context compaction, no plugin API.**
- Weaver has **no git repository of its own**; all changes are uncommitted.
- **Single developer.** Every trade-off above was made by one person, which is itself a
  risk worth naming.

---

## 8. What would be most useful back

Please prioritise over completeness:

1. **Corrections.** Anything in §2 or §3 that is factually wrong, superseded, or that
   security researchers have since disputed.
2. **The attack that gets through** (Q2) and **the platform that refuses** (Q10, Q12).
3. **A ranked list of the top 8 improvements**, each with: the change, the evidence it is
   the right change, roughly what it costs, and what it would displace. We will actually
   build this list, so rank ruthlessly and say what you would cut.
4. **The steal list** — specific things from specific competitors worth copying, and
   specific things from them worth explicitly *not* copying, with reasons.
5. **One thing we should delete.** Genuinely. We would rather ship less, better.

Format: no preamble, no summary of what we said, no hedging that you are an AI. Start with
corrections. Where you are uncertain, say so in a sentence and move on rather than padding.
Where you cite something, give us enough to find it — we will check.
