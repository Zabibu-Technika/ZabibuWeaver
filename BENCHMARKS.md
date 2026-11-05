# Release benchmarks and competitive position

Measured **2026-11-05** on Windows 11 Pro (10.0.26220), Intel Core i5-6300U
(2 cores / 4 threads), 7.8 GB RAM. These are release facts for **Weaver v0.7.0**,
not a model-quality benchmark.

## Release facts

| Item | Value |
|---|---|
| Version | 0.7.0 |
| Windows package | `weaver-0.7.0-win-x64.zip` |
| Zip size | 35,428,156 bytes (33.8 MB) |
| Installed size | 87.7 MB |
| Bundled runtime | Node v24.14.1 |
| SHA256 | `c07101518677966faafc022500942becc4359de82c22564c785e799a3ebd1a52` |
| Signature | Authenticode, Zabibu Technika development certificate |
| Tests | 370 total · 368 pass · 2 skipped |
| Test duration | 171,994 ms |
| Typecheck | clean |
| Runtime npm dependencies | 0 |

## Measured runtime

| Measurement | Result |
|---|---|
| `weaver.exe --version`, warm (5 runs) | 4.19 s, 4.39 s, 4.59 s, 4.60 s, 12.65 s |
| Warm median | **4.59 s** |
| Cold first run | 12.65 s |
| `weaver.exe providers` | 4.42 s |
| Packaged mock one-shot (3 turns, write, read, receipt) | 9.65 s |

The startup cost is real and is the main release-engineering gap. Most of it is Node
loading the TypeScript source tree on a 2-core laptop; Windows Defender contributes to the
cold run. A bundled or SEA build is the next optimization, not a claim we can make yet.

## End-to-end checks on the packaged build

- Extracted the release zip and ran `weaver.exe --version` → `0.7.0`.
- Ran a one-shot mock turn against a clean workspace:
  - wrote `hello.ts`
  - created a content-addressed checkpoint
  - wrote a proof receipt (`.json` and `.md`)
- Verified the GitHub release asset's stored SHA256 digest matches the local build.
- `install.ps1` installed into a custom directory and the installed `weaver.exe` ran.

### Real-model smoke task (one task, not a benchmark)

- **Model:** Groq `openai/gpt-oss-120b`
- **Task:** a failing `sum.test.ts`; fix `sum.ts` so `node --test` passes
- **Result:** test PASS, only `sum.ts` touched, receipt verdict **proved**, self-authored
  checks: **no**
- **Wall time:** 125.5 s for the one-shot turn
- **What this does not prove:** one task, one model, one run. It is a smoke test of the
  packaged loop and the receipt path, not a SWE-bench or model-quality result.

Not yet measured: broad model-quality comparisons, SWE-bench or similar, long sessions, very
large repositories, and behavior under a metered/slow network.

## Competitive matrix

Based on public documentation as of **2026-11-05**, not a hands-on bake-off. Competitor
features change; verify before quoting.

| Capability | Weaver | OpenCode | Claude Code | Codex CLI | Aider | Cursor CLI | Gemini CLI |
|---|---|---|---|---|---|---|---|
| Open source | yes | yes | no | yes | yes | no | yes |
| Local models / offline | yes | yes | no | partial | yes | no | no |
| Model/provider choice | yes | yes | no | partial | yes | no | partial |
| Deterministic change gate | **yes** | no | no | no | no | no | no |
| Proof receipt per turn | **yes** | no | no | no | no | no | no |
| Decision ledger | **yes** | no | no | no | no | no | no |
| Undo without git | **yes** | partial | no | no | no | no | no |
| Multi-account switching | **yes** | no | partial | no | no | no | no |
| Zero runtime npm deps | **yes** | no | no | no | no | no | no |
| LSP / MCP / subagents / plugins | roadmap | yes | yes | yes | partial | yes | yes |
| Windows signed installer | **yes** | unknown | unknown | unknown | unknown | unknown | unknown |

## Honest position

**Where Weaver is ahead.** It is unusually strict about proof: a deterministic gate it
cannot bypass, a receipt a stranger can inspect, self-authored-check detection, a decision
ledger, and undo that does not require git. It also runs with zero runtime npm dependencies
and a keyless default, and it packages as a signed Windows executable with a one-line
installer.

**Where Weaver is behind.** It is much narrower than OpenCode, Claude Code, Codex, Cursor,
and Gemini CLI on surface area: no LSP, MCP, subagents, plugin API, server/API, or live cost
meter yet. Startup is slower than a native agent on this hardware. Model quality is
unbenchmarked, and the Windows build still uses a development certificate, so SmartScreen
trust is not solved until a publicly trusted certificate is issued. The community and
integration ecosystem are small.

**What would change the answer.** A published SWE-bench Verified subset (20–50 tasks, at
least three models, receipts attached), a startup-optimized bundled build, and the first
LSP/MCP/subagent release. Until then, the defensible claim is narrow and true: Weaver is
the agent that proves its work, not the agent with the most features.

## Reproduce

```powershell
cd ZabibuWeaver
npm test
npm run typecheck
.\packaging\build-windows.ps1
```

Then extract `dist\weaver-0.7.0-win-x64.zip`, run `weaver.exe --version`, and compare the
zip hash with `dist\SHA256SUMS.txt`.
