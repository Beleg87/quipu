mod crypto;
mod signaling;
mod voice;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tauri_plugin_store::StoreExt;

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Load or create the persistent keypair from the store.
/// Called on app startup — returns the same keypair every time after first run.
#[tauri::command]
fn load_or_create_keypair(app: tauri::AppHandle) -> Result<crypto::KeypairExport, String> {
    let store = app.store("quipu.json").map_err(|e| e.to_string())?;

    if let Some(v) = store.get("keypair") {
        let kp: crypto::KeypairExport = serde_json::from_value(v)
            .map_err(|e| e.to_string())?;
        return Ok(kp);
    }

    // First launch — generate and persist
    let kp = crypto::generate_keypair().map_err(|e| e.to_string())?;
    store.set("keypair", json!(kp));
    store.save().map_err(|e| e.to_string())?;
    Ok(kp)
}

/// Load saved connection config (server URL + room name).
#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<Value, String> {
    let store = app.store("quipu.json").map_err(|e| e.to_string())?;
    Ok(json!({
        "server_url": store.get("server_url").unwrap_or(json!("")),
        "room":       store.get("room").unwrap_or(json!("quipu-main")),
    }))
}

/// Persist connection config.
#[tauri::command]
fn save_config(app: tauri::AppHandle, server_url: String, room: String) -> Result<(), String> {
    let store = app.store("quipu.json").map_err(|e| e.to_string())?;
    store.set("server_url", json!(server_url));
    store.set("room", json!(room));
    store.save().map_err(|e| e.to_string())
}

/// Connect to the signaling server.
#[tauri::command]
async fn connect_signaling(
    app:         tauri::AppHandle,
    url:         String,
    room:        String,
    fingerprint: String,
    state:       State<'_, signaling::SignalingHandle>,
) -> Result<(), String> {
    state.connect(app, url, room, fingerprint).await.map_err(|e: anyhow::Error| e.to_string())
}

/// Send a chat message through the signaling relay.
/// The payload arrives at the server as an opaque blob and is broadcast to peers.
#[tauri::command]
async fn send_chat(
    text:        String,
    fingerprint: String,
    room:        String,
    state:       State<'_, signaling::SignalingHandle>,
) -> Result<(), String> {
    let msg = serde_json::to_string(&json!({
        "type":    "chat",
        "room":    room,
        "from":    fingerprint,
        "payload": { "text": text },
    }))
    .map_err(|e| e.to_string())?;
    state.send_raw(msg).await.map_err(|e: anyhow::Error| e.to_string())
}

/// Forward a WebRTC signaling message (offer/answer/candidate).
#[tauri::command]
async fn send_signal(
    kind:        String,
    to:          String,
    payload:     Value,
    fingerprint: String,
    room:        String,
    state:       State<'_, signaling::SignalingHandle>,
) -> Result<(), String> {
    let msg = serde_json::to_string(&json!({
        "type":    kind,
        "room":    room,
        "from":    fingerprint,
        "to":      to,
        "payload": payload,
    }))
    .map_err(|e| e.to_string())?;
    state.send_raw(msg).await.map_err(|e: anyhow::Error| e.to_string())
}

// ── App setup ─────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(signaling::SignalingHandle::new())
        .invoke_handler(tauri::generate_handler![
            get_version,
            load_or_create_keypair,
            load_config,
            save_config,
            connect_signaling,
            send_chat,
            send_signal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
