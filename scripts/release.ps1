#!/usr/bin/env pwsh
# release.ps1 - bump version, commit, tag, push
# Usage: .\scripts\release.ps1 -Version 0.1.4 -Notes "What changed"

param(
    [Parameter(Mandatory)][string]$Version,
    [string]$Notes = "See CHANGELOG.md for details."
)

$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Version must be semver format: X.Y.Z"
    exit 1
}

$tag = "v$Version"
if (git tag -l $tag) { Write-Error "Tag $tag already exists"; exit 1 }

Write-Host "Releasing Quipu $tag..." -ForegroundColor Cyan

# ── Cargo.toml ────────────────────────────────────────────────────────────────
$cargoPath = "client\src-tauri\Cargo.toml"
$cargo = [System.IO.File]::ReadAllText("$PWD\$cargoPath")
$cargo = $cargo -replace '(?m)^version\s*=\s*"[\d.]+"', ('version = "' + $Version + '"')
$cargo = $cargo -replace "`r`n", "`n" -replace "`r", "`n"
[System.IO.File]::WriteAllText("$PWD\$cargoPath", $cargo, $utf8NoBom)
Write-Host "  OK $cargoPath"

# ── tauri.conf.json ───────────────────────────────────────────────────────────
$tauriPath = "client\src-tauri\tauri.conf.json"
$tauriText = [System.IO.File]::ReadAllText("$PWD\$tauriPath")
$tauriObj  = $tauriText | ConvertFrom-Json
$tauriObj.version = $Version
$newJson = $tauriObj | ConvertTo-Json -Depth 10
$newJson = $newJson -replace "`r`n", "`n" -replace "`r", "`n"
[System.IO.File]::WriteAllText("$PWD\$tauriPath", $newJson, $utf8NoBom)
Write-Host "  OK $tauriPath"

# ── package.json ──────────────────────────────────────────────────────────────
$pkgPath = "client\package.json"
$pkgText = [System.IO.File]::ReadAllText("$PWD\$pkgPath")
$pkgObj  = $pkgText | ConvertFrom-Json
$pkgObj.version = $Version
$newPkg = $pkgObj | ConvertTo-Json -Depth 5
$newPkg = $newPkg -replace "`r`n", "`n" -replace "`r", "`n"
[System.IO.File]::WriteAllText("$PWD\$pkgPath", $newPkg, $utf8NoBom)
Write-Host "  OK $pkgPath"

# ── CHANGELOG.md ──────────────────────────────────────────────────────────────
$date     = Get-Date -Format "yyyy-MM-dd"
$clPath   = "CHANGELOG.md"
$existing = [System.IO.File]::ReadAllText("$PWD\$clPath")
$entry    = "## [$Version] - $date`n`n$Notes`n`n"
$combined = $entry + $existing
$combined = $combined -replace "`r`n", "`n" -replace "`r", "`n"
[System.IO.File]::WriteAllText("$PWD\$clPath", $combined, $utf8NoBom)
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
