# Quipu

Decentralized voice, text, and screen share for people who own their infrastructure.

Named after the Incan knot-based communication system — decentralized by design.

---

## What it is

| Feature | Status |
|---|---|
| E2EE text chat | ✅ Done |
| Voice (SFU + P2P fallback) | ✅ Done |
| Admin / mod system | ✅ Done |
| Screen share (H.264 HW encode) | 🚧 Phase 2 |
| Remote view + control | Phase 3 |
| Unattended daemon | Phase 4 |

No accounts. No central servers. No passwords. Identity is a cryptographic keypair — your fingerprint is you.

---

## How it works

```
[Tauri client]  ──WebSocket──▶  [Go signaling server]
     │                                   │
     └──────────── WebRTC (SFU) ─────────┘
                        │
              CGNAT fallback: [coturn TURN relay]
```

Every client generates a persistent keypair on first launch. Your public key fingerprint is your identity across all sessions — no registration, no email, no username.

The signaling server handles:
- WebSocket signaling hub (join, leave, chat, moderation)
- Pion SFU — receives audio/video from each client and forwards to all others (single upload regardless of room size)
- Admin/mod roles with persistent ban and mod lists
- AFK auto-move after 10 minutes of mic silence

If the SFU is unreachable, the client automatically falls back to P2P mesh WebRTC.

---

## Architecture

```
quipu/
├── client/                    # Tauri v2 desktop app (Windows)
│   ├── src/
│   │   ├── main.ts            # Full app logic (TypeScript)
│   │   └── styles/main.css
│   └── src-tauri/
│       └── src/
│           ├── lib.rs         # Tauri commands (Rust)
│           └── signaling.rs   # WebSocket client
│
├── signaling/                 # Go server (single binary)
│   ├── cmd/signaling/
│   │   └── main.go            # WS hub + SFU message routing
│   └── internal/
│       ├── sfu/
│       │   ├── room.go        # Pion SFU room (track forwarding)
│       │   └── manager.go     # Room registry
│       └── updater/
│           └── updater.go     # Self-update from GitHub Releases
│
└── .github/workflows/
    ├── ci.yml                 # Lint + build on every push
    └── release.yml            # Build + publish on version tag
```

---

## Running the signaling server

### Download (recommended)

Download the latest `quipu-signaling-windows-amd64.exe` and `quipu-signaling.bat` from [Releases](https://github.com/Beleg87/quipu/releases/latest).

### Using the .bat file

Place both files in the same folder and double-click `quipu-signaling.bat`. It:

- Sets the window title to **Quipu Signaling** so you don't close the wrong window
- Automatically restarts the server if it crashes
- Checks for a newer release on every start and self-updates

```bat
@echo off
title Quipu Signaling
cd /d "%~dp0"

:loop
quipu-signaling-windows-amd64.exe -addr :8181
timeout /t 2 /nobreak >nul
goto loop
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `-addr` | `:8080` | Listen address and port |
| `-data-file` | `quipu-data.json` | Persistent data (bans, mods) |
| `-admin` | *(empty)* | Lock a fingerprint as permanent admin |
| `-tls-cert` | *(empty)* | TLS certificate path (for `wss://`) |
| `-tls-key` | *(empty)* | TLS key path (for `wss://`) |

To disable self-update: set environment variable `QUIPU_NO_UPDATE=1`.

### Build from source

```powershell
cd signaling
go mod tidy
go build -o quipu-signaling.exe ./cmd/signaling
```

### Health check

```
GET http://your-server:8181/health
```

Returns JSON with room count, SFU room stats, and ban count.

---

## Running the desktop client

### Download (recommended)

Download `Quipu_x.x.x_x64-setup.exe` from [Releases](https://github.com/Beleg87/quipu/releases/latest) and run the installer.

The app checks for updates automatically — Settings → Updates → Check for updates.

### Dev mode

```powershell
cd client
pnpm install
pnpm tauri dev
```

---

## First time setup

1. Install and launch Quipu
2. Open **Settings** (⚙ icon, top-left of the sidebar)
3. Enter your server URL: `ws://your-server-ip:8181/ws`
4. Set a nickname
5. Click **Connect**
6. Click any voice channel to join — mic permission is requested on first join

The first person to connect to a fresh server becomes **admin**. This persists across server restarts.

---

## Roles

| Role | Permissions |
|---|---|
| **Admin** | Everything. First to connect gets this. |
| **Mod** | Kick, ban. Promoted by admin. |
| **Member** | Chat, voice, screen share. Default. |

Admin and mod status persists in `quipu-data.json`. Bans are by fingerprint — a banned peer cannot reconnect from the same install.

Manage roles: **Settings → Connected peers**.

---

## Moderation

- **Kick** ⊗ — peer disconnects but can rejoin
- **Ban** ⊘ — fingerprint added to persistent ban list
- **Unban** — Settings → Ban list (admin/mod only)
- **Promote ★+** — make a peer a mod (admin only)
- **Drag to move** — drag a peer's name onto another voice channel to move them (admin/mod only)

---

## Voice channels

- Click a voice channel to join. SFU is tried first (5s timeout), P2P mesh is the fallback.
- Status bar shows `🔊 Main · SFU` or `🔊 Main · P2P`.
- Per-peer volume slider (0–200%) — over 100% uses Web Audio API gain boost.
- Browser-native noise suppression, echo cancellation, and auto gain control always on.
- Audio input/output device selection: **Settings → Audio devices**.
- AFK: 10 minutes of mic silence moves you to the AFK channel automatically.

---

## Screen share

Available in voice channels (SFU mode). Click **⬡** in the voice status bar.

A quality picker appears before capture starts — choose from **Auto** up to **1440p 120fps**. Your GPU handles H.264 encoding (AMF on AMD, NVENC on NVIDIA, QuickSync on Intel). The server forwards raw RTP — zero processing on the server side.

All active screen shares appear as tiles in the main area. **Double-click** any tile to focus it full-screen. Press **Escape** or double-click again to return to the grid.

---

## Connection mode

Settings → Connection mode:

- **Direct (P2P)** — STUN only. Lowest latency. Default.
- **Relay (TURN)** — Routes voice through a coturn server. Fixes CGNAT.

With the SFU active, TURN is rarely needed — the SFU only requires one outbound connection from each client.

---

## Release process (for maintainers)

```powershell
cd E:\quipu
.\scripts\release.ps1 -Version 0.1.x -Notes "What changed"
```

This bumps all version fields, commits, tags, and pushes. GitHub Actions builds the Tauri installer and Go binaries, publishes them to Releases.

The signaling server self-updates from GitHub Releases on every start. The desktop client checks for updates via the Tauri updater.

### GitHub secrets required

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signing key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Key passphrase |

Generate with: `cargo tauri signer generate -w ~/.tauri/quipu.key`

---

## License

MIT
