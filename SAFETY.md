# Safety: why Weaver is not OpenClaw

This document is the design brief for the security architecture. It exists because the
failure mode we are designing against is not hypothetical, it is documented, named, and
has CVE numbers.

**OpenClaw** (formerly Moltbot, Clawdbot) was a self-hosted autonomous agent that
searched the web, read mail and messages, managed files, and executed code on the user's
machine. It became GitHub's most-starred repository within weeks of launch. It then
produced data loss, credential theft, and malware distribution — 255+ GitHub security
advisories, an IMDA warning, and a Trail of Bits audit.

Weaver is meant to give a non-developer the same *reach* an OpenClaw user had, without
giving them the same exposure. That is the entire product thesis, and it is a safety
thesis before it is a features thesis.

---

## 1. The three failures worth stealing from

### 1.1 The lethal trifecta

Researchers (Palo Alto Networks, Jan 2026; IBM X-Force, Apr 2026) reduced OpenClaw's
exposure to three legs:

1. **Deep access to private local data** — files, mail, messages, credentials, memory.
2. **Interaction with untrusted external content** — web pages, search results, email,
   forwarded messages, third-party skills.
3. **The ability to communicate outward** — network calls, mail, messaging, shell.

Any two legs are survivable. **All three at once is an exfiltration machine**, because
an attacker who controls what the agent *reads* can make it *send*.

IBM's framing is the one to internalise: this is not a bug list, it is an architecture
that guarantees the outcome.

### 1.2 The model cannot tell instructions from data

This is the finding that decides the architecture. From the Cloud Security Alliance's
June 2026 review, following OpenAI's Lockdown Mode announcement:

> The long-term defense posture is architectural, not behavioral... the language model
> cannot reliably distinguish operator instructions from content it is processing, and
> defense must therefore be located **outside the model**.

Indirect prompt injection is not a jailbreak problem to be trained away. An attacker
hides instructions in an ordinary email, PDF, or web page; the agent reads it as part of
doing its job; the agent obeys. Radware's *ZombieAgent* work goes further — an injection
can plant persistent logic in the agent's long-term memory, turning it into a silent
insider that survives the original input.

**Consequence for Weaver:** any defense that depends on the model being good at
identifying manipulation is decoration. The control has to live in code the model cannot
talk its way past.

### 1.3 Unprompted action carrying a credential

CVE-2026-25253 is the cleanest single lesson in the whole catalogue. OpenClaw read a
`gatewayUrl` value out of a query string and **automatically opened a WebSocket
connection, without prompting, sending a token with it.** One click. Remote code
execution. CWE-669, incorrect resource transfer between spheres.

Note the shape: attacker-controlled input → automatic outbound connection → credential
rides along → **no human was asked**. That is not a parsing bug. It is a policy that
never required consent for the one action that mattered.

The related "ClawJacked" flaw (Oasis Security, patched 2026.2.26) let malicious
websites hijack a locally running instance and silently exfiltrate data by abusing the
agent's built-in autonomy.

---

## 1.4 These bugs are all patched. That is not the argument.

An honest read of this document has to survive one obvious objection: OpenClaw fixed
CVE-2026-25253 in v2026.1.29 (30 Jan 2026), shipped a skill and plugin safety scanner in
February, SecretRefs in April, and multi-user operator scopes in May. Its MITRE ATLAS
threat model is published. Citing a nine-month-old CVE as the reason for our architecture
would be citing a ghost.

So the case does not rest on any of them. It rests on three things that did not get
patched:

**1. The exposure is the product, not a bug in it.** JFrog examined publicly reachable
OpenClaw instances in February 2026 and found **93.4% with critical authentication
bypasses**. A patch does not change what happens when a self-hosted agent with private
data, untrusted input and outward reach is placed on a machine whose owner cannot audit it.
The number that matters is not advisories-fixed, it is installations-exposed.

**2. It is a class, not a product.** The 2026 corpus is not one vendor's bad quarter:

- **Cursor CVE-2026-26268** (CVSS 9.9) — opening a folder detonated an attacker's
  `pre-commit` hook via the agent's own `git commit`.
- **"Comment and Control"** — a PR title injected through `pull_request_target` made
  Claude Code, Gemini CLI and Copilot exfiltrate Actions secrets. Anthropic paid a $100k
  bounty.
- **GitSpawn** — eight flaws where a repository's own git config fired execution sinks
  *outside* sandbox and approval, across Claude Code, Codex, Cursor, Goose, Hermes, Qwen
  Code and Grok Build. Four were unpatched at publication.
- **Plugin4Shell** — a branch named like a pinned SHA swapped code during auto-update in
  Claude Code, Codex, Copilot and Gemini CLI.
- **Trojanized hook updates** compromised **all seven** harnesses tested, up to **92.5%**
  success across ten attacker objectives.
- **DeepSeek Harness CVE-2026-82533** (CVSS 9.4) — a loopback API checked only by Host
  header let a sandboxed agent switch itself to full access.

Every major agent product in this list shipped a critical or high vulnerability in 2026.
That is not a field with a bug; it is a field with an absent control.

**3. The architectural finding is unpatched because it is not a bug.** The CSA's June 2026
review concluded the defense "must be architectural, not behavioral," because the model
cannot reliably distinguish operator instructions from content. You cannot patch that. You
can only put a control somewhere the model cannot reach — which is the whole of §3.

The CVEs above are kept in this document as *worked examples of a shape*: attacker input,
automatic outbound movement, credential riding along, no human asked. The shape recurs
because the architecture that permits it is the default architecture. Fixing one instance
of the shape is not the same as removing the shape.

---

## 2. The posture OpenClaw took, and the one we take

OpenClaw's published security policy states that the following are **not** security
vulnerabilities by themselves:

> - Prompt injection without a policy, auth, approval, sandbox, or tool-boundary bypass.
> - Malicious behavior in a plugin installed or enabled by a trusted operator.

That is a coherent policy. It is also the line that separates us. It says: if the model
was manipulated but no *system* boundary was crossed, that is not our problem. For a
single developer running a personal assistant, that is defensible. For a product whose
stated users are people who do not write code, it is not — because the person most
likely to be phished by an urgent-sounding message, and least equipped to notice, is
exactly the person we are building for.

Weaver adopts the opposite default:

> **Manipulation of the model is in scope, always.** If untrusted content influenced an
> action, the action needs consent, regardless of whether any other boundary fell.

The Varonis phishing simulation (June 2026) is why. An OpenClaw email agent was fed
phishing mail and leaked AWS credentials, database passwords, and customer data — and it
did so because it **granted access when the request seemed urgent**. Urgency is a
persuasion technique aimed at a human; it worked on the agent.

---

## 3. The four controls

Everything below is enforced in code the model cannot edit or argue with.

### 3.1 Provenance — every piece of content is labelled

`src/trust/taint.ts` tags content with where it came from:

| Provenance   | Meaning                                            | Trust |
|--------------|----------------------------------------------------|-------|
| `user`       | Typed by the human in this session                 | High  |
| `local`      | Output of a local process that did not fetch       | **Residual** |
| `external`   | Fetched from the network **or read off disk**      | **None** |

Two things about this table are load-bearing and were each learned the hard way.

**`local` is much narrower than it looks, and deliberately so.** It does *not* mean "the
user's machine" or "probably safe." It means one specific thing: the output of a process
that did not reach the network. A test suite printing an assertion error is as
attacker-influenced as any file. `local` survives only because labelling every command's
output untrusted would make this layer fire on every build — and the empirical evidence on
that outcome is unambiguous: Anthropic published that its users approve **93% of permission
prompts** in March 2026, rising to **97%** by August. A gate at 97% approval stopped being
read long before it stopped being shown. This is a stated residual risk, not an oversight.

**`external` includes files, and that was a real hole for a long time.** The read tools
used to label everything they returned as `local`, which meant the trust layer never fired
on anything read from disk — a poisoned README in a cloned repo, a dependency's changelog,
a CI log line, even a *filename*. The whole module was effectively a web-only control.
External review found it, and it was the attack that got through.

The reasoning, which is the part worth keeping: **a path is a location, not a trust level.**
Cloning a repository hands you an attacker's filesystem. `npm install` hands you a
stranger's. When the reader of that text is an agent that can run commands, the text is an
instruction channel — and a more reliable one than a webpage, because nobody thinks to
distrust their own disk.

### 3.2 Capability — every tool is classified by what it can do

`read`, `local-write`, `destructive`, and `egress`. Shell is `unbounded`, because a
shell command can do all of them and no classifier can prove otherwise.

### 3.3 Consent — the rule that breaks the trifecta

> A call that can **move data off this machine**, influenced by `external` content,
> **requires explicit human consent, every time, with no "always allow" available.**
> Untrusted text copied *verbatim* into any high-risk call is gated the same way,
> regardless of where that call goes.

That rule severs the third leg of the trifecta. It is the rule that would have stopped
CVE-2026-25253, because "automatically connect and send a token" is precisely an outbound
call influenced by untrusted input, and precisely the case where consent cannot be
pre-granted.

**Why context-level, not value-level.** True data-flow taint tracking is impossible here
for the reason in §1.2: the model paraphrases, compresses, and reformats on every step,
so the external string rarely survives verbatim. We therefore track taint at two levels:

- **Value-level** (cheap, catches the direct case): does the argument text contain a
  fragment of the external content that was ingested this turn?
- **Context-level** (conservative, catches the paraphrase): has this turn ingested
  anything `external` at all? If so, outward actions are treated as influenced.

Value-level is a filter, not the guarantee. Context-level is the guarantee. Being
conservative here costs a confirmation click; being permissive costs a credential.

**What context-level taint does *not* gate, and why that is a decision rather than an
omission.** Once file reads were correctly reclassified as `external` (§3.1), every
coding turn reads files, so `external` is present almost always. A naive reading of the
rule above would then prompt on every shell call and every edit — and the empirical case
against that is strong enough to be decisive: Anthropic published a **97% approval rate**
for Claude Code's permission prompts, and research on oversight capacity (*Oversight Has
a Capacity*, arXiv 2606.08919) found realized safety is an **inverted-U in escalation
rate** — more human oversight can make a system *less* safe, with a demonstrated
"flooding attack" that slips a malicious action past a fatigued reviewer.

So the gate is narrowed along one axis, and the axis is chosen rather than assumed:

- **Shell is judged by reading the command.** A tool's paraphrased intent is unreadable,
  which is why context-level taint must gate conservatively. A shell command's reach is
  not unreadable — it is written in the argument, in front of us, every time. `npm test`
  cannot exfiltrate and `curl` can, and we can see which. So we read it rather than
  assume. This is the load-bearing asymmetry in the module, and it is what lets this layer
  stay strict about exfiltration without prompting on every build.
- **`destructive` is the permission gate's job**, not this one, and that gate already asks.
  The trust layer exists for the trifecta, which is about data *leaving*, not about data
  being lost.

Note that this narrowing is safe in exactly the direction that matters: an ordinary local
command cannot carry a secret off the machine, so not asking about one cannot leak
anything. The cost of a wrong "allow" here is bounded by what the command can physically
do. The cost of a wrong "confirm" everywhere is a user who has stopped reading.

### 3.4 Disclosure — hidden instructions are surfaced, not silently obeyed

When external content contains instruction-shaped text (imperatives, "ignore previous
instructions", base64 blobs, embedded shell payloads, encoded URLs), Weaver does not
pretend it saw nothing. It reports the signals to the human alongside the content, so
the user can see what the agent was handed.

---

## 4. What this buys, concretely

| OpenClaw failure                                   | Weaver control |
|----------------------------------------------------|----------------|
| CVE-2026-25253 — auto WebSocket with token         | §3.3: egress + external ⇒ consent, never pre-granted |
| ClawJacked — website hijacks local agent           | §3.3 + external provenance on all web content |
| Varonis phishing sim — leaks on urgent mail        | §3.3: egress of credential-shaped data always asks |
| Meta researcher's deleted email                    | §3.3: destructive ⇒ consent; §5 below limits blast radius |
| Memory poisoning / ZombieAgent                     | §3.3: memory is `external`-derived, never auto-trusted |
| Malicious skill packages                           | Skills are `external` by definition |
| Privilege sprawl (Backslash finding)               | Capability is declared per tool, visible, and testable |

---

## 5. The limits of this design — stated honestly

These are real, and pretending otherwise would repeat OpenClaw's mistake in a new place.

1. **Context-level taint is coarse.** If a user asks a legitimate question, the agent
   reads a web page, and then legitimately sends an email, that email requires consent
   even though it was probably fine. We accept the extra click. The alternative — asking
   the model whether it was influenced — is the defense §1.2 says does not work.
2. **A shell command is unclassifiable.** `unbounded` is the honest label, so shell
   carries the strictest rules. Users on `--permission full` opt out of this entirely,
   and that choice is theirs to make, but the default must not be the dangerous one.
3. **This is not a sandbox.** Nothing here contains a malicious *binary*; the Canary
   sign-off catches bad changes after the fact, and this catches manipulation before.
   Neither replaces OS-level isolation, which is a separate layer we do not yet ship.
4. **Consent fatigue is a real attack.** If everything asks, users learn to type "yes".
   The controls in §3 are deliberately narrow — only outward, destructive, and unbounded
   actions — so that a confirmation means something when it appears.

---

## 6. Non-goals

- **No plugin or skill marketplace.** The supply-chain vector that produced malicious
  ClawHub packages is out of scope for now, deliberately.
- **No always-on background agent.** Persistence multiplies every injection into a
  standing threat (§1.2). Sessions are explicit and bounded.
- **No auto-approval of egress under any configuration flag.** There is no `CANARY_ACK`-style
  switch in this product, and adding one would be the same mistake as shipping a
  bypass, only slower.
