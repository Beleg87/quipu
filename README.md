# Quipu

> Decentralized voice & encrypted chat for people who own their infrastructure.  
> Named after the Incan knot-based communication system — decentralized by design.

[![CI](https://github.com/quipu-app/quipu/actions/workflows/ci.yml/badge.svg)](https://github.com/quipu-app/quipu/actions/workflows/ci.yml)

---

## What it is

| Feature | Status |
|---|---|
| E2EE text chat + voice | 🚧 Phase 1 |
| Screen share (H.264 HW encode) | Phase 2 |
| Remote view (passive) | Phase 3 |
| Remote control | Phase 4 |
| Unattended daemon | Phase 5 |

**No accounts. No central servers. No passwords.**  
Identity is a Noise Protocol keypair. Your public key fingerprint *is* you.

---

## Architecture

```
[Tauri client] ──WS──▶ [signaling server (Go)]
       │                       │
       └──WebRTC (Noise E2EE)──┘
              ↓ CGNAT fallback
          [coturn TURN relay]
```

### Repo layout

```
quipu/
├── client/              # Tauri v2 desktop app
│   ├── src/             # Web frontend (TypeScript)
│   └── src-tauri/       # Rust backend
│       └── src/
│           ├── crypto.rs      # Noise keypair generation
│           ├── signaling.rs   # WS client to signaling server
│           └── voice.rs       # WebRTC voice pipeline (Phase 1)
├── signaling/           # Go signaling server
│   └── cmd/signaling/
│       └── main.go
└── .github/workflows/
    ├── ci.yml           # lint + test on every push/PR
    ├── release.yml      # build + publish on version tag
    └── nightly.yml      # auto-tag nightly at 03:00 UTC
```

---

## Quickstart

### Signaling server (your gaming server)

```bash
cd signaling
go build ./cmd/signaling
./quipu-signaling -addr :8080

# With TLS (recommended for public deployment):
./quipu-signaling -addr :443 -tls-cert cert.pem -tls-key key.pem
```

Health check: `GET /health`

### Desktop client (dev)

```bash
cd client
pnpm install
pnpm tauri dev
```

---

## Release channels

| Tag pattern | Channel | Audience |
|---|---|---|
| `v0.1.0-nightly.N` | Nightly | Friend group |
| `v0.1.0-beta.N` | Beta | Wider testers |
| `v0.1.0` | Stable | Public |

Releases are built by GitHub Actions and published to GitHub Releases.  
The Tauri auto-updater pulls from the latest release JSON.

---

## Secrets required (GitHub → Settings → Secrets)

| Secret | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signing key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Key passphrase |

Generate with: `cargo tauri signer generate -w ~/.tauri/quipu.key`

---

## License

MIT
