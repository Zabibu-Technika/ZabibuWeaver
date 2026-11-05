# Weaver

**The local-first coding agent that signs off on its own work.**

Your agent wrote the change. Canary already knows how to judge it — in plain English,
with a signed receipt a stranger can verify. Weaver is the agent half of that idea:
it works in your repo, and every mutating action is gated before it happens and
reviewed by the same engine before the turn is done.

> **Weaver builds the nest. Canary guards the mine.**
>
> A [Zabibu Technika](https://zabibu.vercel.app) product · built by Tehillah Kachila.

---

## Status

`v0.7.0` — a working core with a real terminal UI, a self-contained sign-off, a judge
that fails closed, **verification before "done", proof receipts, a decision ledger,
reversible file changes, scope pushback, and context compaction**. The loop runs, the
tools work, the permission gate works, sessions persist, the sign-off fires against the
vendored engine, and the TUI streams, scrolls, and prompts inline.

What it does **not** yet have: an LSP, sub-agents, MCP, a plugin API, a server/API, a
live cost meter, or lineage analysis. See **[ROADMAP.md](ROADMAP.md)** for the full
tracker — including the African-realities and self-dependence workstreams — and
[Limitations](#limitations).

Read **[EDGE.md](EDGE.md)** for what actually makes this different from opencode, Claude
Code and Codex — and the rule that follows from it for what gets built next.
Read **[COMPETITORS.md](COMPETITORS.md)** for the October 2026 sweep of the field: the
permission and verification models, the review market's three tiers, the non-developer
landscape, and the resulting prioritized steal list.

## Repositories and site

- **Code:** this repository — <https://github.com/Zabibu-Technika/ZabibuWeaver>
- **Weaver site:** [`site/`](site/) — <https://zabibuweaver.vercel.app>
- **Arif Agent (multi-axis sibling):** <https://github.com/Zabibu-Technika/ArifAgent>
- **Fikra site and product hub:** <https://github.com/Zabibu-Technika/ZabibuFikra> — <https://zabibufikra.vercel.app>
- **Company site:** <https://zabibu.vercel.app>

Arif Agent is a separate repository, not a folder here. Clone it beside this one so its
sync daemon can find `../ZabibuWeaver`; the site is deployed from `site/` with
`vercel --prod --yes --project zabibuweaver`.

## Quickstart

**No key, no account, no config.** Weaver starts on a free keyless endpoint:

```bash
node src/index.ts          # opens the TUI
```

If you already have `GROQ_API_KEY` (or `GEMINI_API_KEY`, `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, `TOGETHER_API_KEY`) in your environment, Weaver finds it and uses
that provider instead — usually faster and better. Either way you can:

```bash
npm run providers          # every endpoint, and which keys are present
npm run setup              # pick a free provider and paste a key
npm run models             # what the active provider actually offers
```

### What setup does now

`weaver setup` reads the machine before it asks for a key: CPU, RAM, free disk, and whether
you are an administrator. It recommends the largest Ollama model that fits, offers to pull
it, and writes a safe base workspace at `~/.weaver/workspace`. Projects go there by default;
`-C <dir>` chooses another. The write and shell gates still ask — being an administrator
does not turn that off, and `full` is never chosen for you.

The vendored judge is refreshed and re-pinned with `npm run vendor:engine`; the engine
itself is checked under its own rules with `npm run typecheck:engine`.

Offline, with no network at all:

```bash
npm run mock               # a scripted session that writes, reads, and summarises
npm run smoke              # asserts the loop actually created the file
npm run smoke:canary       # asserts a hardcoded secret gets BLOCKED by the sign-off
npm run smoke:tui          # drives the real TUI with synthetic keys, no terminal needed
```

One-shot, non-interactive:

```bash
node src/index.ts -p "add a health endpoint to server.ts"
```

Node **22.18+** runs the TypeScript directly — there is no build step and no bundler.
The runtime has **zero dependencies**. `npm install` is only needed for `npm run typecheck`.

## The terminal UI

The default interactive mode. Alternate screen, raw-mode input, a scrolling
transcript, live streaming, inline permission prompts, and a status bar — hand-rolled
on ANSI, so it adds no dependency that could rot.

```
╭────────────────────────────────────────────────────────────────────────────╮
│ weaver · the local-first coding agent           pollinations/openai · auto  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│ add a health endpoint to server.ts and write a test for it                 │
│ → read_file  server.ts                                                     │
│ ✓ read_file · 3ms                                                          │
│   server.ts (lines 1-42 of 42)                                             │
│ → edit_file  src/app.ts (2048 bytes)                                       │
│ ✓ edit_file · 8ms                                                          │
│   replaced 1 occurrence(s) in src/app.ts                                   │
│ I added a `/health` route that returns the uptime and version, and a       │
│ matching test in `server.test.ts`.                                         │
│                                                                            │
│ ⠋ running read_file  4.2s                                                  │
├────────────────────────────────────────────────────────────────────────────┤
│ you ▸ refactor the auth module_                                            │
│ enter send · /help · ↑↓ history · ctrl+c twice exits    auto · canary auto │
╰────────────────────────────────────────────────────────────────────────────╯
```

| Key | Does |
| --- | --- |
| `enter` | send · while busy, queues the message to run next |
| `esc` / `ctrl+c` | cancel the running turn |
| `ctrl+c` twice | exit |
| `ctrl+l` | clear the transcript |
| `ctrl+u` / `ctrl+w` | kill to line start / delete previous word |
| `↑` `↓` | history (or scroll the transcript when the input is empty) |
| `pgup` / `pgdn` | scroll back through the transcript |

Permission prompts appear **inline in the input line**, and `y` / `n` / `a` answer
them: `allow write_file settings.ts (94 bytes)?   [y] yes   [n] no   [a] always`.

Commands: `/help` `/tools` `/permission` `/canary` `/provider` `/session`
`/sessions` `/clear` `/exit`.

It degrades safely. `--plain` skips it; so does a non-TTY (a pipe or `-p`); so does a
window under 40×8. And the layout is a pure function (`src/tui/frame.ts`) with tests
asserting the frame is *exactly* the window height and *exactly* the window width at
every size — because a frame one row too tall scrolls the alternate screen, and one
cell too wide tears the borders.

Painting is equally opinionated: each row is cleared *before* it is drawn, never after.
Clearing after would fire `CSI K` while the cursor sits in the terminal's pending-wrap
state on the final cell, erasing the cell underneath it — every row on screen would lose
its right border. The encoder is a pure function too (`encodeFrame`), so that ordering is
asserted directly, and `npm run smoke:tui` replays the real paint stream through a small
terminal emulator to confirm the borders survive.

## Providers — free by default

Any OpenAI-compatible endpoint. Every preset is reachable with one key, and the first
is reachable with none:

| Provider | Tier | Key | Notes |
| --- | --- | --- | --- |
| `pollinations` | free | **none** | The default. No account at all. Community-run and best-effort, so slower. |
| `groq` | free | `GROQ_API_KEY` | Fastest of these. The best choice if you want speed. |
| `gemini` | free | `GEMINI_API_KEY` | Generous free tier, via Google AI Studio. |
| `openrouter` | free | `OPENROUTER_API_KEY` | One key, hundreds of models; ids ending `:free` cost nothing. |
| `ollama` | free | none | Runs locally. Nothing leaves your machine. |
| `openai` | paid | `OPENAI_API_KEY` | |
| `together` | paid | `TOGETHER_API_KEY` | |
| `mock` | offline | none | Scripted. Makes the loop testable with no network. |

Resolution order: `--provider` → `WEAVER_PROVIDER` → `~/.weaver/config.json` → any key
found in your environment → the keyless default. `WEAVER_BASE_URL` overrides everything
and points at any OpenAI-compatible endpoint, so anything not listed still works.

### Endpoints that cannot call tools

Not every free endpoint honours the `tools` parameter. Rather than making those
useless, the system prompt teaches the model a textual protocol:

```
<function=read_file>{"path": "src/index.ts"}</function>
```

…and the same salvage parser that heals Groq's malformed output reads it back. That
combination is what lets a tool-less free endpoint drive a real agent. `weaver config`
tells you which mode is active.

Two smaller accommodations for the same reason: endpoints that ignore `stream: true`
get their single JSON body replayed in chunks so the transcript still fills in
gradually, and keyless endpoints are not sent an empty `Authorization` header.

## The sign-off — the part opencode does not have

Two gates, in order:

1. **Before** — the permission gate. Reads run freely; `write_file`, `edit_file` and
   `run_shell` ask first (`y` / `N` / `a` for *always this session*), and `readonly`
   mode refuses them outright.
2. **After** — the Canary sign-off. Once a turn has changed anything, Weaver diffs the
   workspace, runs it through **the same engine** that powers the Canary web app and
   CLI (`packages/engine`), and reports the findings. If there is a `critical` finding
   and no approval in `~/.zabibucanary/ledger.jsonl`, the turn is **BLOCKED**.

```
[ canary ] shared engine
  risk 34/100 · grade C · Stop — fix these first (1 file(s), +1 / -1)
  [critical] Possible hardcoded secret in added lines
    file: settings.ts
  BLOCKED — critical findings without a signed approval.
  Weaver cannot sign this itself. Clear the findings and re-run, or have a human
  sign the receipt in Canary (`zabibucanary review`).
· sign-off BLOCKED — handing the findings back for repair pass 1/1
✓ 4ms replaced 1 occurrence(s) in settings.ts
[ canary ] shared engine
  risk 0/100 · grade A · Looks good to go (1 file(s), +1 / -1)
  no findings — the change looks safe.
· the sign-off cleared after 1 repair pass
```

There is no `CANARY_ACK`-style switch anywhere, on purpose. Weaver embeds the judge,
not the pen, so it cannot approve its own work — the only routes out of a block are a
real fix or a human signature in Canary.

The engine is **vendored into Weaver**, not imported from a sibling checkout — so
Weaver runs on its own, anywhere, with no second project to find. `src/engine/` holds
byte-for-byte copies of Canary's `analyze.ts`, `impact.ts` and `plain.ts`, pinned by
`provenance.json` to an upstream commit and a sha256 hash per file:

- `npm run vendor:engine` re-copies them from `../zabibu-canary/packages/engine/src`
  (or `--from <dir>`), refreshing the pins.
- `npm run typecheck:engine` checks them under **Canary's** compiler options, not
  Weaver's: the two projects disagree on `noUncheckedIndexedAccess`, and the vendored
  files are forbidden to be edited into compliance. The main typecheck excludes them.
- `src/engine/provenance.test.ts` recomputes the hashes on every test run — edit a
  vendored file even by a comment and it fails — and, when a sibling checkout is
  present, compares against it and fails the moment upstream moves.

The engine imports nothing but itself and reads no files, no env and no network. It is a
pure function of the diff, which is why the same change produces the same `analysisId` in
Weaver and in a Canary CLI on another machine.

Deliberately **not** vendored: `ledger.ts`, the signing half. Weaver embeds the judge, not
the pen — it can read the approval ledger and be blocked by it, but it cannot generate a
key or write a receipt.

`WEAVER_CANARY=off` disables the sign-off. `WEAVER_CANARY_ENGINE=<path>` overrides the
vendored engine, for A/B-ing it against a working tree during Canary development — the
default is always the pinned copy, and an override that points somewhere unusable does
**not** silently fall back to the embedded copy.

### The sign-off fails closed

An unjudged change is not a clean one. If the judge cannot be loaded, or throws while
analysing the diff, Weaver does not report a clean turn — it reports `SIGN-OFF FAILED`,
marks the change **blocked**, and says why. Semgrep's rule: an internal error must never
register as a pass, because the alternative is a gate that silently stops working and
nobody notices it is off.

The same applies to the loop itself: a sign-off that fails in an unexpected way is
surfaced as an error, never swallowed.

### The fix-verify loop

A blocked verdict is information, and the model that caused the block is better placed
to act on it than the human reading the output. So when the sign-off blocks, Weaver
hands the findings back to the model and runs the judge again:

```
· sign-off BLOCKED — handing the findings back for repair pass 1/1
✓ 4ms replaced 1 occurrence(s) in settings.ts
· the sign-off cleared after 1 repair pass
```

What this does **not** weaken: nothing here can approve anything. It is the same
`reviewWorkspace` call against the new diff, and only the ledger approves. The repair
pass changes who does the copy-pasting, not who decides.

Three deliberate limits:

- A **failing judge is never handed to the model.** An engine that will not load is not
  a coding problem, and inviting a repair would mean rewriting files to satisfy a gate
  that never ran.
- It is bounded — `WEAVER_CANARY_REPAIR` repair passes, default `1`, hard-capped at `5`.
  `0` restores the older behaviour of stopping at the first verdict.
- It **stops early when the analysis id is unchanged**, because the same diff produces
  the same verdict and asking twice teaches nothing. This is the repair loop's own
  guard against the doom loop that the feature would otherwise create.

The brief the model receives is worth reading, because it is where a repair loop goes
wrong if it is written carelessly (`src/core/agent.ts`, `repairBrief`). It tells the
model, explicitly, that it cannot approve its own work, that deleting or neutering
whatever produced the finding is not a fix, and that a false positive should be raised
rather than quietly routed around. A loop that omitted those would be a machine for
teaching an agent to launder a finding instead of answering it.

## Trust boundaries

Weaver's target user is not only a developer. It is meant to let someone who has never
opened a terminal run an agent on their own machine — which is exactly the configuration
that made OpenClaw dangerous. **[SAFETY.md](./SAFETY.md)** is the full write-up, with the
CVEs; the short version is the "lethal trifecta" researchers used to describe OpenClaw's
exposure: private data access, untrusted content, and outward communication, all at once.
Any two are survivable. All three is an exfiltration machine.

`src/trust/taint.ts` severs the third leg. Every piece of content is labelled where it
entered — `user` (typed by the human), `local` (from their machine), or `external` (web,
email, messages, a skill). Every tool declares a capability: `read`, `local-write`,
`destructive`, `egress`, or `unbounded` (shell, which is all of them).

> A high-risk call influenced by untrusted content requires consent, every time, with no
> "always allow" available.

That is the rule that would have stopped CVE-2026-25253, where OpenClaw read a URL out of
a query string and opened a connection, sending a token, without prompting. Consent that
sticks is the vulnerability, so taint never authorises in advance.

Taint is tracked at two levels on purpose. Value-level (the external string appears
verbatim in the arguments) is a filter, not a guarantee — the model paraphrases on every
step, so the string rarely survives. Context-level (this turn ingested *anything*
untrusted) is the guarantee. It is coarser and costs extra clicks. That trade is
deliberate: the cost of being conservative is a click, and the cost of being permissive is
a credential.

Instruction-shaped text found in untrusted content is **disclosed**, not silently obeyed —
and disclosure survives `--permission full`, because telling the user what happened costs
them nothing, while hiding it behind a verbosity flag is OpenClaw with better manners.

## Onboarding and profiles

`src/onboard/profiles.ts` holds one dial with five positions, from `explorer` (has never
opened a terminal) to `expert` ("ponytail-style" developer who wants correction,
conversation, and verification). Each position presets the permission mode, whether to ask
before edits, the toolset offered, how much the agent explains itself, and how many repair
passes it gets after a blocked sign-off.

**The trap, and why the file is shaped the way it is:** it would be easy, and wrong, to
treat "security safeguards" as another notch on the same dial, so an expert gets a looser
gate. The Varonis phishing simulation in June 2026 tricked *the agent*, not a beginner —
it leaked AWS keys and customer data because it granted access when a request felt urgent.
The operator's skill level was irrelevant. So the dial controls friction, exposure, and
verbosity. It does not control whether the trust boundaries hold; those are in
`INVARIANTS`, they are not fields on any profile, and a test fails if anyone ever wires
one up as a knob.

Classification is deterministic and dumb on purpose, and its output is always a *proposal*
shown to the human. A permission level the user never agreed to is the same failure as a
silently inferred mode.

## The knowledge graph

`src/memory/graph.ts` is a local memory of what the user's words refer to. When someone
says "the dashboard", the agent should resolve it in O(1) rather than grep the repository
and put six files in the context window to work out they meant
`src/pages/Dashboard.tsx`.

The saving is measurable and asserted in tests: for twelve ambiguous references, the graph
costs ~180 tokens where the file-dump alternative costs ~4,000 — a 20x reduction, bounded
by construction so it does not grow with the project. Tokens cost money, latency, and
energy to produce, and Weaver runs on laptops.

Two things keep it honest:

- **Provenance.** Only `user`-confirmed entries are authoritative. Content from elsewhere
  is stored and retrievable but marked `unverified` and never auto-applied. Radware's
  *ZombieAgent* research showed persistent memory is the ideal injection channel — an
  instruction that reaches memory outlives the input that carried it — so nothing derived
  from untrusted content may become a fact the agent acts on.
- **The reject list.** When a user says a reference is wrong or irrelevant, it stops
  resolving and stops entering context. Irrelevant references are exactly what should not
  be paid for on every turn. Only the human can override a rejection.

## Architecture

```
bin/weaver.mjs            entry shim (Node strips the types)
src/
  index.ts                CLI entry — subcommands, one-shot, TUI or plain REPL
  config.ts               env + .env + ~/.weaver/config.json; auto-detection
  setup.ts                the interactive "connect a provider" wizard
  core/
    types.ts              messages, tools, provider interface, findings
    agent.ts              the loop, plus the fix-verify loop around the sign-off
    session.ts            sessions as JSON under ~/.weaver/sessions
    prompt.ts             the system prompt; the prompted-tool protocol
  engine/
    analyze.ts, impact.ts, plain.ts   the vendored Canary judge (byte-identical, pinned)
    index.ts              Weaver's barrel — excludes the signing half on purpose
    provenance.json       the upstream commit + sha256 of every vendored file
    provenance.test.ts    fails if a vendored file is edited, or upstream moves
    tsconfig.json         the engine, checked under its own compiler options
  providers/
    presets.ts            the registry: endpoints, keys, tiers, tool support
    openai.ts             any OpenAI-compatible endpoint — SSE or single-body
    toolcalls.ts          salvages tool calls from malformed model output
    mock.ts               scripted offline provider — makes the loop testable
    index.ts              provider selection
  tools/
    files.ts              read_file, write_file, edit_file, list_dir, glob_files, grep
    shell.ts              run_shell — declared `unbounded`, because it is
    index.ts              the registry
  trust/
    taint.ts              provenance, capability, the consent rule, injection signals
    taint.test.ts         incl. a guard that every tool declares its risk class
  onboard/
    profiles.ts           the dial: explorer → expert, plus INVARIANTS it cannot move
    profiles.test.ts      no profile may carry a field shaped like a bypass
  memory/
    graph.ts              local knowledge graph, provenance-gated, bounded context
    graph.test.ts         the reject list, and a measured token saving
  permissions/gate.ts     the conscience — mutations, and now the trust rule
  integrate/
    canary.ts             the sign-off — vendored judge, ledger check, fails closed
    canary.test.ts        the judge's failure modes must block, not pass
  tui/
    ansi.ts               colour, control sequences, width-aware text
    keys.ts               raw-mode key parsing (escape sequences, bracketed paste)
    frame.ts              pure frame composition — the layout invariant, tested
    app.ts                the state machine and terminal plumbing
  cli/                    args, rendering, subcommands, the plain readline REPL
scripts/                  offline smoke tests (loop, sign-off, and the TUI)
```

## Tools

| Tool | Mutating | What it does |
| --- | --- | --- |
| `read_file` | no | Read a file, optionally a line range |
| `list_dir` | no | List a directory |
| `glob_files` | no | Find files by pattern (`src/**/*.ts`) |
| `grep` | no | Search contents with a regex |
| `write_file` | **yes** | Create or overwrite a file |
| `edit_file` | **yes** | Exact-string replace; fails unless unique (or `replaceAll`) |
| `run_shell` | **yes** | Run a command in the workspace |

Every path is resolved and checked against the workspace root, so the agent cannot
leave the project it was pointed at.

## Permission modes

| Mode | Reads | Writes & shell |
| --- | --- | --- |
| `auto` *(default)* | run freely | ask `[y/N/a]` |
| `full` | run freely | run without asking |
| `readonly` | run freely | refused |

## Undo

Every mutating call takes a checkpoint **before** it runs:

```bash
weaver checkpoints              # what can be undone, newest first
weaver checkpoints diff <id>    # exactly what one undo would change
weaver undo                     # restore the newest one (asks first)
weaver undo <id>                # restore a specific one
```

In a session, `/undo` previews and `/undo yes` applies. Nothing is ever restored
automatically, because a restore overwrites current files and can delete files the call
created — so the preview exists to make the confirmation informed rather than ritual.

Checkpoints are content-addressed blobs under `.weaver/checkpoints`, not shadow git: a
snapshot costs one hash per touched file, where `git init` costs about two seconds on a
modest machine. `write_file` and `edit_file` capture their exact target. `run_shell`
sweeps the workspace within a byte and file budget, and **records every file it declined
to cover** rather than claiming completeness it does not have.

When a sweep saw the whole tree, undo can also delete files the command *created* —
`touch deploy.sh` followed by undo leaves nothing behind. When the sweep was truncated,
it refuses to guess and says so.

## Verification and decisions

After a mutating turn, Weaver runs the project's own checks before the sign-off: package
scripts, a `tsc` fallback for TypeScript projects, `cargo test`, `go test`. A failure goes
back to the model for one bounded repair pass. The commands come from the project
manifest, never from the model.

```bash
weaver verify        # run the checks now
weaver decisions     # what the project has already settled, and why
```

Decisions are an append-only ledger. Changing your mind supersedes an entry; it never
deletes one. The active ones are injected into the prompt, bounded, so the agent stops
proposing the approach you rejected an hour ago.

### Proof receipts

A mutating turn writes `.weaver/receipts/<id>.{json,md}`: the commands that ran, their
exit codes, timing, output digests, the Canary analysis id, and every path the turn
touched. Output is not copied into the receipt — a failing test can print a secret.

```bash
weaver receipts              # what was proved, and when
weaver receipts show <id>    # the artefact
```

The status is derived from evidence, not self-report:

| Status | Meaning |
| --- | --- |
| `proved` | every check passed, none was authored by this turn, nothing skipped |
| `partial` | something passed, but the proof is incomplete or not independent |
| `unproven` | no checks ran — not a pass |
| `failed` | a check failed |

If the turn edited a test file, a test config, or the check command, the result is capped
at `partial`: the judge was changed by the thing it judged.

## Accounts and integrations

Weaver reads the identity layer from the CLIs you already use:

```bash
weaver integrations                    # GitHub and Vercel accounts
weaver integrations use github teh317  # switch, and remember it for this workspace
```

- **GitHub** is read through `gh auth status --json hosts`, so every authenticated account
  is listed and switchable with `gh auth switch`.
- **Vercel** is read through `vercel teams ls` (JSON first, table fallback) plus
  `vercel whoami`; `vercel switch <scope>` changes the deploy identity.
- **Anything else** can declare a manifest in `.weaver/integrations/<id>.json`.

The choice is remembered per workspace in `.weaver/integrations.json`. The CLI remains the
source of truth for what is active; if it disagrees with the remembered choice, both are
shown rather than one silently winning. Arif Agent's dashboard has the same registry as an
**accounts** page, with a confirmation modal and a `:` command palette.

## Sessions and config

Sessions are one JSON file each under `~/.weaver/sessions` — resume with
`--resume <id>`, list with `weaver sessions`. The provider choice lives in
`~/.weaver/config.json`, written by `weaver setup` or `weaver auth <provider> <key>`.
A key saved there is only used for the provider it names, and an environment variable
of the same name takes precedence. Nothing is written until a session has at least one
message, so opening Weaver and leaving leaves no trace.

## Where this came from

Weaver continues a thread that started as **Zabibu Architect** — a dry skeleton in
`D:\…\Zabibu Architect\AI_Workspace`: Agno + Groq + Streamlit, three tools, and one
heroic workaround. When Groq rejected Llama's malformed XML tool call, the skeleton
regex-scraped `<function=create_new_folder …>` out of the *error string* and ran the
tool anyway.

That workaround was the seed of this harness, and its wound is now a proper code path:
`src/providers/toolcalls.ts` parses malformed tool calls with a real balanced-JSON
scanner and applies them deliberately — and `openai.ts` recovers the intended call
from Groq's `failed_generation` **before** the error is ever surfaced. The same parser
now also carries providers that have no native tool calling at all.

A mirror of this repo lives in that old workspace (see `sync.ps1`).

## Limitations

Known and deliberate at `v0.2.0`:

- **New files are not covered by the sign-off.** `git diff` cannot see untracked
  files. Weaver does *not* stage them, because staging would change the diff hash and
  break receipt matching with the Canary CLI. It tells you what it did not cover — but a
  warning is not a gate, and this is the most important thing left to fix. See
  [EDGE.md](EDGE.md#the-hole-in-the-moat--fix-this-before-adding-features).
- **The TUI has been driven by exactly one human in a real terminal** — and that is how
  its first bug was found: every row lost its last character, because a trailing `CSI K`
  fired while the cursor sat in the terminal's pending-wrap state on the final cell, so it
  erased the cell *under* the cursor (`╮`, `│`, `╯`). Fixed by clearing each row *before*
  drawing it, never after. Two regression tests now hold the line: one asserts the encoded
  byte stream contains no clear after content, and `npm run smoke:tui` replays the real
  paint stream through a small terminal emulator and checks the right border actually
  survives. Live resize and exotic escape sequences are still only exercised by those
  simulations.
- **The loop is linear.** No sub-agents, no parallel tool calls.
- **No context compaction.** Long sessions will eventually exceed the model's window.
- **`grep` and `glob_files` walk the tree** with a capped budget — fine for normal
  repos, not for a monorepo with hundreds of thousands of files.
- **The mock provider is scripted**, not a simulator — it cannot adapt to tool results.
- **Provider defaults drift.** Model ids retire; that is why `weaver models` exists.

## License

MIT © Zabibu Technika (Tehillah Kachila) — see [LICENSE](LICENSE).
