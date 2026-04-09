#!/usr/bin/env pwsh
# release.ps1 - bump version, commit, tag, push
# Usage: .\scripts\release.ps1 -Version 0.1.1 -Notes "What changed"

param(
    [Parameter(Mandatory)][string]$Version,
    [string]$Notes = "See CHANGELOG.md for details."
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Version must be semver format: X.Y.Z  e.g. 0.1.1"
    exit 1
}

$tag = "v$Version"

if (git tag -l $tag) {
    Write-Error "Tag $tag already exists"
    exit 1
}

Write-Host "Releasing Quipu $tag..." -ForegroundColor Cyan

# ── Cargo.toml ────────────────────────────────────────────────────────────────
$cargoPath = "client\src-tauri\Cargo.toml"
$cargo = Get-Content $cargoPath -Raw
$cargo = $cargo -replace '(?m)^version\s*=\s*"[\d.]+"', ('version = "' + $Version + '"')
Set-Content $cargoPath $cargo -NoNewline
Write-Host "  OK $cargoPath"

# ── tauri.conf.json ───────────────────────────────────────────────────────────
$tauriPath = "client\src-tauri\tauri.conf.json"
$tauri = Get-Content $tauriPath -Raw | ConvertFrom-Json
$tauri.version = $Version
$tauri | ConvertTo-Json -Depth 10 | Set-Content $tauriPath
Write-Host "  OK $tauriPath"

# ── package.json ──────────────────────────────────────────────────────────────
$pkgPath = "client\package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.version = $Version
$pkg | ConvertTo-Json -Depth 5 | Set-Content $pkgPath
Write-Host "  OK $pkgPath"

# ── CHANGELOG.md ──────────────────────────────────────────────────────────────
$date     = Get-Date -Format "yyyy-MM-dd"
$clPath   = "CHANGELOG.md"
$existing = Get-Content $clPath -Raw
$header   = "## [$Version] - $date"
$newline  = [System.Environment]::NewLine
$entry    = $header + $newline + $newline + $Notes + $newline + $newline
Set-Content $clPath ($entry + $existing) -NoNewline -Encoding UTF8
Write-Host "  OK CHANGELOG.md"

# ── Git ───────────────────────────────────────────────────────────────────────
git add -A
git commit -m "chore: release $tag"
git tag $tag
git push
git push --tags

Write-Host ""
Write-Host "  $tag pushed - GitHub Actions is building now." -ForegroundColor Green
Write-Host "  https://github.com/Beleg87/quipu/actions"
Write-Host ""
Write-Host "  Friends will see the update in Settings -> Updates" -ForegroundColor Cyan
