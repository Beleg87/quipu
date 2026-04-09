# Releasing Quipu

Everything your friends need happens automatically once you push a tag.
This file is the complete checklist.

---

## One-time setup (do this once, skip forever after)

### 1. Generate signing keys

```powershell
cd E:\quipu\client
pnpm tauri signer generate -w C:\Users\YOUR_USERNAME\.tauri\quipu.key
```

Save both outputs in your password manager:
- **Public key** → paste into `client/src-tauri/tauri.conf.json` (the `pubkey` field)
- **Private key** → paste into GitHub Secrets (see step 3)

### 2. Update tauri.conf.json

Replace the two placeholders:
```json
"pubkey": "YOUR_PUBLIC_KEY_HERE",
"endpoints": [
  "https://github.com/Beleg87/quipu/releases/latest/download/latest.json"
]
```

### 3. Add GitHub Secrets

Go to: `https://github.com/Beleg87/quipu/settings/secrets/actions`

Add these two secrets:

| Name | Value |
|------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | The private key string from step 1 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Your passphrase (empty string `""` if you used none) |

### 4. First release

Build and push `v0.1.0` using the release script below. From this point on,
your friends install once and get updates automatically.

---

## Every release (the normal flow)

### Option A — Use the release script (recommended)

```powershell
# From the repo root
.\scripts\release.ps1 -Version 0.1.1 -Notes "Fixed chat relay, added auto-update"
```

The script:
1. Bumps the version in all three places
2. Commits the change
3. Pushes the commit and tag
4. GitHub Actions builds, signs, and publishes the release
5. `latest.json` is uploaded — existing clients get the update prompt

### Option B — Manual steps

```powershell
# 1. Bump version in three files (all must match):
#    client/src-tauri/Cargo.toml       → version = "0.1.1"
#    client/src-tauri/tauri.conf.json  → "version": "0.1.1"
#    client/package.json               → "version": "0.1.1"

# 2. Update CHANGELOG.md with what changed

# 3. Commit, tag, push
git add -A
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push && git push --tags
```

GitHub Actions takes it from there (~8 minutes).

---

## What GitHub Actions does

When you push a tag matching `v*.*.*`:

1. **Builds** the Windows `.exe` in release mode (signed with your key)
2. **Generates** `latest.json` with the version, download URL, and signature
3. **Publishes** a GitHub Release with:
   - `Quipu_0.1.1_x64-setup.exe` — the installer (share this with new friends)
   - `Quipu_0.1.1_x64-setup.exe.sig` — the signature
   - `latest.json` — what existing clients poll to detect updates
   - `quipu-signaling-*` — updated signaling server binaries

## What your friends see

When you release a new version, the next time they open Quipu:
- Go to **Settings → Updates → Check for updates**
- If an update is available, they'll see the version number and a one-click Install button
- Download happens in the background with a progress bar
- On Windows, the installer runs silently and the app restarts automatically

---

## Signaling server update

If the signaling server binary also changed (rarely needed), replace it on your gaming server:

```powershell
# Download the new binary from the GitHub Release page, then:
# Stop the old one, replace the .exe, restart it
.\quipu-signaling-windows-amd64.exe -addr :8181
```

The server is backwards-compatible — old and new clients can connect simultaneously.

---

## Troubleshooting

**Build fails with "TAURI_SIGNING_PRIVATE_KEY not set"**
→ Check the secret name matches exactly (no spaces, correct case)

**"latest.json" not found after release**
→ Make sure `includeUpdaterJson: true` is in `release.yml` (it is, don't remove it)

**Friends don't see the update prompt**
→ Check they're on a version that has the updater (v0.1.0+)
→ The updater only checks when they click "Check for updates" — it's not automatic yet

**SmartScreen warning on first install**
→ Normal without a paid code signing certificate
→ Tell friends: click "More info" → "Run anyway"
→ Builds reputation over time; warning fades after enough installs
