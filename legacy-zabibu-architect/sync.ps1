# Mirror Weaver into the original Zabibu Architect workspace, so the thread that
# started there visibly continues here.
#
# One-way by design: this repository is the source of truth; the copy on D: is a
# snapshot kept for continuity. Never edit the mirror.
#
#   pwsh -File sync.ps1
#   pwsh -File sync.ps1 -Target "D:\somewhere\else"

param(
  [string]$Target = 'D:\Work & School\Zabibu Technika\Projects\Zabibu Architect\AI_Workspace\weaver'
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot

if (-not (Test-Path -LiteralPath $source)) { throw "source not found: $source" }

New-Item -ItemType Directory -Force -Path $Target | Out-Null

# /MIR mirrors, deleting files in the target that no longer exist here.
# Exclude build output, VCS metadata, scratch space, and any real secrets.
robocopy $source $Target /MIR `
  /XD node_modules .git .scratch `
  /XF .env tsconfig.tsbuildinfo `
  /NFL /NDL /NJH /NJS /NP | Out-Null

# robocopy reports 0-7 for success; 8+ is a real failure.
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }

Write-Output "mirrored -> $Target"
