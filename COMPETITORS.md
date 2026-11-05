# Competitors — what the field does, and what Weaver should steal

*Measured **2026-10-20**. Stars from the GitHub REST API; npm downloads are the registry's
`last-week` window (2026-10-12→18); PyPI from pypistats. Where a figure is secondary or a
search snippet rather than a page opened directly, it is flagged. This replaces the earlier
sweep wholesale — the field moved enough in one quarter that the old tables were wrong.*

---

## 0. The one-page version

1. **Nobody has solved consent.** They have moved it. The industry converged on
   *classifier-gated autonomy* (Claude auto mode), *watch mode for sensitive context*
   (OpenAI), *typed intents for the highest-risk actions* (Apple), and *always-human for
   payments* (Google, Meta, and what consumers themselves demand). If Weaver ships only
   "Always allow?" checkboxes, it ships the failure mode Anthropic measured at 97%.
2. **The review market is real money, and it is not won on verifiability.** CodeRabbit is at
   **$50M ARR** on speed. Qodo raised **$70M Series B** explicitly on "code verification."
   Our deterministic-gate thesis is unfunded but not unsold — it is just unproven.
3. **Memory with provenance is green field.** Not one shipping product gates memory writes
   on source trust. Our knowledge graph is the most differentiated thing in the codebase,
   and independently-verified numbers say non-LLM ingestion beats LLM ingestion on *both*
   cost and accuracy.
4. **The non-developer market is real but concentrated and shallow.** Meta Muse got 5M
   downloads in three weeks. Broad consumer payment for AI is still ~2% of the population.
   Trust, not capability, is the stated purchase criterion — and consent is currently being
   granted *under resignation*, not conviction.
5. **Our cross-platform vision needs re scoping around a hard fact:** Google Play
   *prohibits* autonomous Accessibility API use, iOS cannot drive other apps, and watchOS
   is out. Android's real path is sideloading via Shizuku/Termux — a two-tier design.

---

## 1. Terminal harnesses — open source

| Product | Stars | Permission model | Review layer | Sandbox |
|---|---|---|---|---|
| **OpenClaw** | 392,704 | Channel pairing + tool profiles + per-agent allow/deny + read-only | `openclaw security audit` (deterministic, auto-fix) | **Optional, off by default** |
| **OpenCode** | 218,750 | Per-tool `ask/allow/deny` table + globs; default *allow* for edit/bash | User-defined read-only reviewer subagents | **None** |
| **Codex CLI** | 130,181 | `--sandbox` × `--ask-for-approval`, two orthogonal knobs | **Guardian + auto-review + circuit breaker** | **OS sandbox, network off default** |
| **pi** | 116,680 | **None by design**; `--tools` allowlist; extension veto | None | None |
| **Gemini CLI** | 107,470 | 4 modes + Policy Engine | None | 4 backends (Seatbelt/gVisor/Docker/LXC) |
| **OpenHands** | 91,405 | Per-action approval in GUI; **headless auto-approves all** | Trajectory logs | **Docker (default)** |
| **Zed** | 91,957 | Regex rules + documented precedence + un-overridable `rm -rf` rules | Checkpoints + diff surface | None |
| **Cline** | 70,722 | Per-category auto-approve (CLI default **true**) | **Shadow-git checkpoints** | None in CLI |
| **Open Interpreter** | 68,621 | Codex-style + hooks | QA skill drives the UI | **Native, all three OSes** |
| **Goose** | 55,460 | 4 modes; **Autonomous is the default** | `PermissionJudge` LLM classifier | None |
| **Aider** | 49,663 | None — **git is the gate** | **Auto-lint + auto-test repair loop** | None |
| **LangGraph** | 43,593 | You build `interrupt()` gates | LangSmith Engine opens PRs | You supply it |
| **CrewAI** | 59,922 | `human_input=True` per task | Task Guardrails | None |
| **smolagents** | 29,949 | None — `CodeAgent` runs Python | None | E2B/Modal/Docker |

**The churn matters more than the table.** Aider is dormant (no commits since 2026-05-22).
AutoGen is **archived** with an explicit security warning. Gemini CLI was **retired for
consumer accounts on 2026-06-18**. Roo Code was archived May 2026. Plandex is abandoned.
Goose was donated to the Linux Foundation. Meanwhile **Codex CLI does 13.1M npm installs a
week** and OpenClaw sits at 392k stars. This field is consolidating fast, and a solo
product survives by being *different*, not by being *bigger*.

### Where Codex CLI is genuinely ahead of us

Worth studying rather than admiring:

- **Guardian** intercepts approvals and returns approve/deny/escalate without a human
  prompt, evaluating operation type, file-path scope, network destination and MCP
  provenance. Structured `guardian_decision` logs carry a `risk_score`.
- **Auto-review sees the action and the evidence but never the agent's chain-of-thought** —
  it "judges the action against the evidence, not the agent's internal justification."
  That is a better design than letting the reviewer read the defendant's own argument.
- **Circuit breaker: 3 consecutive denials, or 10 in 50 recent reviews, aborts the turn**
  rather than burning tokens in a retry loop.
- Denial returns a rationale **plus an anti-circumvention instruction** plus a requirement
  to find a materially safer alternative.
- Policy is **plain Markdown** a user can edit.

---

## 2. Proprietary coding agents

**Claude Code** is bundled into consumer Claude plans, and its `auto` mode became the
default in Aug 2026 — a classifier vets every tool call, broad wildcard allow-rules are
*dropped* on entering auto so the classifier still sees dangerous commands, and repeated
blocks escalate to a human. Deny rules apply in every mode; protected-path deletes are
never auto-approved.

**The number to remember:** Anthropic published that its users approve **93% of permission
prompts** (Mar 2026), rising to **97%** by August. They shipped auto mode explicitly to
solve that. This is the empirical case for the design in §6 — a gate that fires constantly
is not a cautious gate.

**Cursor** was acquired by SpaceX for $60B (closed Aug 2026) and hit $2B ARR — but it also
took **CVE-2026-26268** (CVSS 9.9): a bare git repo in a folder made the agent's own
`git commit` fire an attacker's `pre-commit` hook. Opening the folder detonated it.

**Devin/Windsurf** merged and repriced; **Amazon Q Developer is being sunset** (signups
closed May 2026) in favour of the spec-driven Kiro — a hyperscaler's developer agent that
failed on distribution.

**GitHub Copilot's cloud agent** has the best *organisational* consent architecture I
found: ephemeral Actions environment, admin policy, repo opt-out, and GitHub explicitly
recommends branch rules requiring **a second human approver** on any Copilot PR, stating
that "creating a PR is a handoff for human review, not an autonomous approval."

---

## 3. End-user / computer-use agents — the market we are pivoting into

This is the section that matters for Weaver's actual direction, and it did not exist in
the previous sweep.

| Product | Target | Confirmation | Isolation | Shipped to non-programmers? |
|---|---|---|---|---|
| **Meta Muse** | Normal people | Approve-before-act; activity log; revoke connectors | **Muse Secure VM**, per-user | **Yes — 5M downloads/3 weeks** |
| **Gemini Spark/Agent** | Normal people ("busy parent") | Opt-in per-app; ask-first on spend/send/pay | Google secure cloud | Yes (paid, geo-gated) |
| **ChatGPT Work** | Normal people | Confirm high-impact; **watch mode** pauses if you leave | Cloud VM | Yes |
| **Claude (Cowork)** | Normal people | Per-app permission for screen access; delete = Allow | **Cloud by default since Oct 6 2026** | Yes |
| **Apple Siri AI** | Normal people | **Typed App Intents only**; confirm sensitive | On-device + PCC | Limited beta |
| **Microsoft Copilot** | Normal people | — | — | **Regressing**: Ask Copilot disabled Aug 2026 |
| **OpenClaw** | Tinkerers | Approvals bound to request/command/session/person | **Opt-in** | No — 3.3★ app, "not a product" |

**Meta Muse is the single most important competitor** and it has nothing to do with
coding. 5M downloads in three weeks, #1 App Store, ~600K US DAU. Its architecture is the
part to copy: a **per-user Secure VM** housing both agent and data, untrusted-input
labeling, approval gates, a visible activity log, one-click connector revocation, and a
natural-language "forget that." Its *defaults* are the part to litigate against —
training-on-your-interactions defaults ON and can only be changed during setup, and it has
already leaked a seller's home address to a Marketplace buyer and synced ~187,000 lines of
Messages despite Full Disk Access being off. **Amazon blocked it from shopping** in Sept 2026.

**Microsoft is the cautionary tale.** Copilot buttons stripped from Notepad and Snipping
Tool, Ask Copilot disabled Aug 14 2026, Copilot+ PC branding quietly retired, Outlook
Copilot features removed Oct 2026. Unsolicited ambient agent surfaces get rejected. Their
rebound play is enterprise: **Autopilot** (built on OpenClaw), mandatory **Entra Agent
ID** per agent, and **Execution Containers** for policy-driven file/network containment.

### Is the non-developer market real?

**Adoption — real but shallow and top-heavy:**
- Menlo Ventures, Sept 2026 (n=5,067): **41% of US AI users have tried an agent; 24% use one
  regularly.** 72% know they exist. Consumer AI spend **$40B in 2026, 3× the $12B of 2025**,
  on essentially flat user growth.
- But **the top 14% of payers account for 60% of spending**, and **92% of agent users pay for
  AI vs 55% overall**. Agent use is currently a *power-user behaviour*.
- Counter-data keeps it honest: PNC/a16z put **only 2.2% of consumers** paying for AI as of
  May 2026 (avg $31/mo); Bank of America ~3%. The honest headline is that broad consumer
  payment is still low-single-digits of the population, and among people who already pay,
  agent usage is the strongest predictor of paying more.

**What they say they'll delegate** (Accenture, n=25,590): 74% would trust an agent more
than their best friend to make a purchase — but **only 9%** would let it complete one
without final approval. Worldpay: among those open to agentic payments, **59% want to
approve every purchase individually**, and the three demanded safeguards are confirmation
before purchase, human support if something goes wrong, and time to reverse.

**The complaint patterns are a roadmap of what not to do:** setup friction killing
non-technical users (OpenClaw's own reviews), billing traps (Replit's agent-created
negative balance *blocking cancellation*), bundling churn (ChatGPT's July merge backlash;
Anthropic having to merge Cowork back into Claude), memory unreliability (the #1 named
expectation *and* the #1 named failure), and platform retaliation (Amazon blocking Muse).

---

## 4. Review and verification — the market Weaver is actually in

**Per-vendor numbers** (Signal65, Mar 2026):

| Tool | Precision | Note |
|---|---|---|
| Cursor BugBot | **95.95%** | 23% fewer TP than CodeRabbit |
| CodeRabbit | 95.88% | 93 TP / 4 FP; **$50M ARR** on speed |
| Greptile | 86.36% | |
| Qodo Merge | 81.13% | **129 TP**, 7.5× CodeRabbit's recall; **$70M Series B** on "verification" |
| GitHub Copilot | **64.35%** | 41 false positives |

**Precision and recall are inversely ordered across every vendor.** Nobody leads both, and
the market has not decided which it wants.

### The strongest argument *for* our deterministic gate

**ALIBI** (arXiv `2607.24964`, Jul 2026): inert **source-code comments that do not change
program behaviour reliably suppress LLM vulnerability detection** across four detector
classes. No compiler, test, or analyzer catches it, because the payload is
behaviour-neutral. An LLM judge is not merely fallible — it is *gameable by construction*,
and the attacker's tool is a comment.

**Semgrep's SusVibes** finds the same thing from the other direction: Claude Opus 5.5 passed
functional tests on **93.5%** of tasks, but only **54.8% were both working and secure** —
and **41% of working solutions reintroduced the original vulnerability.** Passing tests is
not security review.

**DeepSource** documents the commonest LLM-only failure as *zero output* — the reviewer
skipped the vulnerable code entirely.

### The strongest argument *against* our thesis

Nobody has made verifiable review pay. Codacy **Verity** is the closest analogue — a model
that didn't write the code reviews the change, **backed by deterministic static analysis**,
emitting `PASS/WARN/FAIL` — and it is a feature inside a larger company, not a breakout.
CodeRabbit's $50M ARR was won on **speed**, not on trust.

**Where the field beats us:** they have false-positive rates published and independent
testing (Doyensec for Semgrep: WebGoat CE 48%→72% TP with **1 FP**). We have no
calibration, no false-positive number, and no corpus. That is the gap to close first.

### What to steal from the reviewers

- **Tri-state output** (`PASS`/`WARN`/`FAIL`) rather than a score — Verity's shape.
- **Publish the false-positive rate**, not the accuracy claim.
- **"The gate lives in your branch protection rule, not in the tool"** — the accepted
  pattern is lint/type/tests/SAST as required checks, AI advisory, then promote to
  required *after calibration*.

---

## 5. Memory and context engineering

**Provenance-gated memory writes: nobody ships it.** The only artifacts are a proposed
Mem0 issue and **MemSentry** (arXiv `2609.08747`) — deterministic Accept/Review/Quarantine
on source trust, with signed security-state deltas. Anthropic's own memory tool has no
injection defense beyond filesystem control. **This is green field with a published
blueprint, and Weaver's graph is already built.**

**Token costs, with real numbers:**

| System | Tokens |
|---|---|
| Full context re-injection | **25,000+** |
| Mem0 read | 6,787–6,956 |
| Zep read | 5,760 @ 155ms |
| Mem0 paper (per conversation) | ~1,764 vs 26,031 naive (**90%+ saving**) |
| **Weaver `contextFor()`** | **~180** |

**And the number that vindicates the architecture:** Letta's own docs note that "a 2K-token
persona block costs 2K tokens per turn, **forever**" — always-in-prompt memory is a
permanent tax. Independent benchmarking (Shabbir, Jun 2026, 419-turn support bot) found
**vendor numbers do not reproduce**: Mem0's published 92.5 scored **50.0 measured**; Zep's
94.7 scored **37.0**. Critically — **the two systems with no LLM at ingestion finished 1st
and 3rd.** Deterministic ingestion is both cheaper *and* more accurate.

That is exactly our design, arrived at for safety reasons and vindicated on performance.

**The anti-pattern to avoid:** Supermemory's proxy layer routes every LLM request through
their servers — "developers no control over what context got injected." A memory layer you
don't control is an injection layer you don't control.

---

## 6. Platforms — the hard constraints on the cross-platform vision

| Platform | Verdict |
|---|---|
| **iOS / iPadOS** | **Bounded possible, cross-app forbidden.** Foundation Models 3B on-device + App Intents + MCP. Cannot drive another app's UI, ever. |
| **watchOS** | **Forbidden standalone** — phone-proxied display only. Drop it. |
| **macOS** | Possible, but **sandbox is unresolved** — `apple/containerization` #737 (opened May 2026, still open) asks Apple for a `sandbox-exec` replacement. |
| **Windows** | **Strongest story.** Agent Framework `get_computer_tool()` — app owns the execution environment, presents safety approval, acts, screenshots, returns. PowerShell execution policy is explicitly **"not a security boundary."** |
| **Linux** | **Strongest sandbox.** Landlock: unprivileged, one-way, child-inherited, ephemeral. |
| **Android / Play** | **Forbidden.** Verbatim Play policy: *"any use of the Accessibility API that enables an app to autonomously initiate, plan, and execute actions or decisions is strictly [prohibited]"* — enforced by Permission Declaration Form since 2021. |
| **Android / sideload** | **Possible.** Shizuku (uid 2000, SELinux-bound, shell perms vary by OEM, re-auth every reboot) + Termux:API. Precedent: **Mythara** (MIT, 65+ tools, deliberately scoped). |

**The design that falls out:** a **two-tier Android split** — a constrained Play-compliant
companion, and a sideloaded power tier via Shizuku/Termux — rather than one product
pretending to be allowed everywhere. And **watchOS out of scope**, which saves months.

**Cross-platform precedent is thin.** `nanoMuse` (GPL-3.0) runs one agent across
Android/iOS/desktop/browser with the phone and computer as "hands" and a self-hostable
relay. Humane raised $230M and sold for $116M.

---

## 7. The consolidated steal list

Ranked by value per unit of complexity, for a local-first agent aimed partly at
non-developers.

1. **Shadow-git checkpoints after every mutating call (Cline).** Snapshot per tool use; offer
   diff → restore → **keep the conversation**. Cline's docs say it outright: *"Checkpoints
   make auto-approve practical."* Cheaper than sandboxing and more legible to a novice than
   a permission prompt. **This is the highest-value item on the list for us.**
2. **Capability-scoped harness, verified empirically (arXiv `2609.08371`).** Checking tool
   calls against typed capabilities held *outside the model* dropped injected actions from
   **33–47 of 75 runs to 3 of 75**. That is the strongest external validation of
   `capabilityOf()` that exists, and we already have it.
3. **A reviewer that never sees the actor's chain-of-thought, plus a circuit breaker (Codex).**
   Judge the action against the evidence, not the defendant's own argument. Abort the turn
   on 3 consecutive denials instead of looping.
4. **Regex permission rules with a stated precedence ladder, un-overridable floor rules, and
   a rule tester (Zed).** `always_deny > always_confirm > always_allow > tool default >
   global default`. Hard-coded, non-overridable `rm -rf`-class rules. A "test your rules"
   checker before you ship a pattern. Shell *chain* parsing so `a && rm -rf ~` is checked
   sub-command by sub-command.
5. **Deterministic post-edit verification: lint-on-edit + test-after-edit with auto-repair
   (Aider).** The cheapest honest review layer — no LLM judge, no trust, works offline.
6. **Separate the containment knob from the approval knob (Codex).** Two orthogonal settings,
   with the rule that *the looser the approval mode, the stronger the sandbox must be.*
7. **Three-tier action taxonomy (OpenAI system card):** automatic / confirm-and-show-state /
   **watch mode** — sensitive context forces live, tab-active supervision that auto-pauses
   on inactivity. The best answer to consent fatigue: don't ask more, ask while *forcing
   attention* on the highest-risk slice.
8. **Typed intents for the highest-risk surfaces (Apple).** Money, health and communications
   act only through declared schemas, with `OwnershipProvidingEntity`-style prompts that
   fire *with context* when data is shared or public.
9. **Approval binding to the exact request, command, session and person (OpenClaw 2.0)**, plus
   **credentials that reach destinations without ever entering model-visible text.**
10. **A deterministic security-audit doctor command with check IDs, severities and auto-fix
    (OpenClaw).** Non-developers will not read a threat model. They will run `weaver doctor`.
11. **Checks-as-code on every PR (Continue's `.continue/checks/`).** Markdown in the repo that
    runs as agents and surfaces as status checks — non-developers already understand "the
    check turned red."
12. **Never let the agent write or delete its own trace** (arXiv `2609.30266` shows agents
    deleting their own logs unprompted, across OpenCode/Claude Code/Codex/Antigravity/Grok).
    Ship logs to storage the process cannot open, or the review layer is fiction.
13. **An honest safety page with a reporting channel (Anthropic's "Use Claude Cowork
    safely").** Two-condition threat model in plain English, "chances are non-zero," a
    "don't use this for sensitive info" list, and an address to report to. Menlo finds
    buyers now rank **accuracy (45%), trustworthiness (40%), security/privacy (36%) ahead of
    ease of use (32%)** — candor is a feature.
14. **Publish the token meter.** Aider prints "Repo-map: using 1024 tokens"; pi publishes a
    **<1,000-token** system prompt against 7–10k elsewhere. Local-first users feel cost
    directly. Show ours.

### What Weaver already does better

- **Deterministic gate + human sign-off as the product**, not as an add-on. Every competitor's
  automated reviewer is an LLM, and ALIBI shows why that is gameable.
- **Trust boundaries as invariants rather than settings.** No profile turns them off, and a
  test fails if a bypass-shaped field is added. Compare Goose's *Autonomous* default.
- **Provenance-gated memory.** Green field; nobody ships it; independently benchmarked as
  both cheaper and more accurate than the LLM-ingestion incumbents.
- **Zero runtime dependencies** — and in a year where **Plugin4Shell** hit four major
  harnesses and trojanized hook updates compromised all seven tested ones at up to **92.5%**
  success, that is a security property, not a constraint.

### Where the field is clearly ahead

- **Sandboxing.** We ship none. Codex has OS-level with network off by default; Gemini had
  four backends; OpenHands defaults to Docker; DeepSeek Harness **fails closed** when no
  backend exists. We are the weakest in the field on containment.
- **Checkpoints/undo.** Cline, Zed and LangGraph all have it. We have nothing, and it is
  item #1 for non-developers.
- **False-positive calibration.** We have no number at all.
- **A plugin ecosystem** — deliberately absent, but it is why OpenClaw has 392k stars.

---

## 8. Do not copy

1. **Default-on autonomy without containment.** Goose's Autonomous default, OpenHands
   headless, OpenCode's default-allow for edit and bash with no sandbox at all.
2. **`--yolo` as a documented primary path.** It teaches users that safety is a flag.
3. **Approval logic that parses a different string than it executes** (Mistral Vibe,
   CVE-2026-87987/87984 — env prefixes, redirects, ANSI-C quoting all bypass approval).
   Every shell feature you don't model is a hole.
4. **Unreviewed auto-updating plugins.** Plugin4Shell hit Claude Code, Codex, Copilot and
   Gemini CLI via a branch named like a pinned SHA. **341 malicious ClawHub skills** bypassed
   scanning. Any marketplace you ship becomes your incident feed.
5. **Repo-local config treated as trusted** — **GitSpawn** (8 flaws across Claude Code, Codex,
   Cursor, Goose, Hermes, Qwen Code, Grok Build) fires git config execution sinks *outside*
   sandbox and approval. Codex's `codex trust` is the pattern; implicit loading is not.
6. **Classifier as the only gate.** Red-teaming showed **79% bypass** of Claude Code Auto Mode
   and Codex Guardian via injection-against-the-monitor, multi-agent attacks and malicious
   compaction (arXiv `2609.19587`). Use classifiers as a *cost optimiser*, never as the
   boundary.
7. **Secrets in plaintext on disk**, and secrets inside the project tree — PixelLeak caught
   agents pushing **13,000+ screenshots from 300+ orgs** to public repos while "helpfully"
   solving an attachment problem.
8. **A local HTTP control plane with weak auth** — DeepSeek Harness CVE-2026-82533 (CVSS
   9.4) let a sandboxed agent escalate itself to full access over loopback.

---

## 9. Sources

Primary, fetched or measured 2026-10-20 unless dated. GitHub REST API (stars, push dates);
npm downloads API; pypistats · zed.dev/docs/ai/tool-permissions · opencode.ai/docs/agents ·
docs.cline.bot (checkpoints, auto-approve, cli-reference) · aider.chat/docs/usage/lint-test ·
docs.openclaw.ai/gateway/security · developers.openai.com/codex/agent-approvals-security ·
docs.langchain.com/langgraph · Signal65 *Evaluating AI Code-Review Tools* (Mar 2026) ·
Menlo Ventures *2026 State of Consumer AI* (Sep 16, n=5,067) · Accenture Consumer Pulse 2026
(n=25,590) · Worldpay Agentic Commerce 2026 · Usercentrics/Sapio *Resigned Consent*
(Sep 28, n=11,000) · Anthropic engineering (Mar 25 / Aug 7 2026) · Anthropic *Use Claude
Cowork safely* · OpenAI system card · arXiv 2607.24964 (ALIBI) · 2609.08371
(capability-scoped harness) · 2609.08747 (MemSentry) · 2609.19587 (classifier bypass) ·
2609.30266 (trace tampering) · 2606.08919 (*Oversight Has a Capacity*) · Shabbir memory
benchmark (Jun 17, 2026) · Semgrep SusVibes · Doyensec Semgrep evaluation · MITRE ATT&CK
v20 (Oct 19, 2026, AGT-001/002/006) · Play Console Accessibility policy ·
`apple/containerization` #737 · The Register (Aug 31, 2026) · Cisco Blog (Jan 28, 2026) ·
404 Media (Feb 1, 2026) · Bloomberg (Mar 11, 2026) · Datadog Security Labs (OpenCode
GHSA-632h-h47v-g4x4) · Ox Security (CVE-2026-82533) · air.security (Plugin4Shell) ·
Manifold (GitSpawn) · Glow (PixelLeak).

**Caveats.** Star counts ≠ usage — `claw-code`'s README calls itself a museum exhibit at
195k★. Registry counts include CI and mirrors. Two download lookups errored and are absent.
DeepWiki pages for Goose and OpenHands were rate-limited, so those entries rest on
first-party docs plus search-index snippets.
