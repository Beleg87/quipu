## [0.1.6] - 2026-04-10

Fix infinite reconnect loop, stabilize signaling connection

# Changelog

All notable changes to Quipu are documented here.

---

## [Unreleased]

## [0.1.0] — 2025-04-09

### Added
- Repo scaffold: Tauri v2 client shell, Go signaling server, GitHub Actions CI/CD
- Keypair persistence via tauri-plugin-store (identity survives restarts)
- Real WebSocket signaling client (tokio-tungstenite)
- E2EE text chat relayed through signaling server
- Voice channel with WebRTC peer connections and Opus audio
- Settings UI: signaling server URL, room name, fingerprint display
- Auto-updater with progress UI in Settings → Updates
- Three-channel release pipeline: Nightly → Beta → Stable
- Custom title bar with working minimize / maximize / close
- Verdigris colour scheme (not Discord blue)
