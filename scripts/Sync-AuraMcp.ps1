# One-line wrapper: the Aura MCP row generator now lives in Node (Sync-AuraMcp.mjs).
#
# Kept so existing call sites, notes and the managed block's own comment
# ("Regenerate with: Sync-AuraMcp.ps1") keep working unchanged.
#
#   .\Sync-AuraMcp.ps1                 # sync the web profile's managed block
#   .\Sync-AuraMcp.ps1 -DryRun         # report only
#   .\Sync-AuraMcp.ps1 -Migrate        # also drop legacy hand-written rows
#   .\Sync-AuraMcp.ps1 -Remove         # delete the managed block
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 decodes a BOM-less .ps1 with the
# machine's ANSI code page, and non-ASCII bytes swallow line breaks (already hit once in
# this repo).

param(
    [switch]$DryRun,
    [switch]$Migrate,
    [switch]$Remove,
    [switch]$Check,
    [switch]$Channel,
    [string]$Patch,
    [string]$EmitBundlePatch,
    [string]$EmitOverlay,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

$generator = Join-Path $PSScriptRoot 'Sync-AuraMcp.mjs'
if (-not (Test-Path -LiteralPath $generator)) {
    Write-Error "Sync-AuraMcp.ps1: generator not found at $generator"
    exit 1
}

$nodeArgs = @($generator)
if ($DryRun) { $nodeArgs += '--dry-run' }
if ($Migrate) { $nodeArgs += '--migrate' }
if ($Remove) { $nodeArgs += '--remove' }
if ($Check) { $nodeArgs += '--check' }
if ($Channel) { $nodeArgs += '--channel' }
if ($Patch) { $nodeArgs += @('--patch', $Patch) }
if ($EmitBundlePatch) { $nodeArgs += @('--emit-bundle-patch', $EmitBundlePatch) }
if ($EmitOverlay) { $nodeArgs += @('--emit-overlay', $EmitOverlay) }
if ($Json) { $nodeArgs += '--json' }

& node @nodeArgs
exit $LASTEXITCODE
