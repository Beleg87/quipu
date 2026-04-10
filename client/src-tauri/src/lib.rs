mod crypto;
mod signaling;
mod voice;

use serde_json::{json, Value};
use tauri::State;
use tauri_plugin_store::StoreExt;

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn load_or_create_keypair(app: tauri::AppHandle) -> Result<crypto::KeypairExport, String> {
    let store = app.store("quipu.json").map_err(|e| e.to_string())?;
    if let Some(v) = store.get("keypair") {
        let kp: crypto::KeypairExport = serde_json::from_value(v).map_err(|e| e.to_string())?;
        return Ok(kp);
    }
    let kp = crypto::generate_keypair().map_err(|e| e.to_string())?;
    store.set("keypair", json!(kp));
    store.save().map_err(|e| e.to_string())?;
    Ok(kp)
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<Value, String> {
    let store = app.store("quipu.json").map_err(|e| e.to_string())?;
    Ok(json!({
        "server_url": store.get("server_url").unwrap_or(json!("")),
        "room":       store.get("room").unwrap_or(json!("quipu-main")),
        "nickname":   store.get("nickname").unwrap_or(json!("")),
        "ice_mode":   store.get("ice_mode").unwrap_or(json!("direct")),
        "turn_url":   store.get("turn_url").unwrap_or(json!("")),
        "turn_user":  store.get("turn_user").unwrap_or(json!("")),
        "turn_pass":  store.get("turn_pass").unwrap_or(json!("")),
    }))
}

#[tauri::command]
fn save_config(
    app:        tauri::AppHandle,
    server_url: String,
    room:       String,
    nickname:   String,
    ice_mode:   Option<String>,
    turn_url:   Option<String>,
    turn_user:  Option<String>,
    turn_pass:  Option<String>,
) -> Result<(), String> {
    let store = app.store("quipu.json").map_err(|e| e.to_string())?;
    store.set("server_url", json!(server_url));
    store.set("room",       json!(room));
    store.set("nickname",   json!(nickname));
    if let Some(v) = ice_mode  { store.set("ice_mode",  json!(v)); }
    if let Some(v) = turn_url  { store.set("turn_url",  json!(v)); }
    if let Some(v) = turn_user { store.set("turn_user", json!(v)); }
    if let Some(v) = turn_pass { store.set("turn_pass", json!(v)); }
    store.save().map_err(|e| e.to_string())
}

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
    })).map_err(|e| e.to_string())?;
    state.send_raw(msg).await.map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn send_moderation(
    action:      String,  // "kick" | "ban" | "unban" | "promote" | "move"
    payload:     serde_json::Value,
    fingerprint: String,
    room:        String,
    state:       State<'_, signaling::SignalingHandle>,
) -> Result<(), String> {
    let msg_type = match action.as_str() {
        "kick"    => "kick",
        "ban"     => "ban",
        "unban"   => "unban",
        "promote" => "promote",
        "move"    => "move",
        _         => return Err(format!("unknown action: {action}")),
    };
    let msg = serde_json::to_string(&json!({
        "type":    msg_type,
        "room":    room,
        "from":    fingerprint,
        "payload": payload,
    })).map_err(|e| e.to_string())?;
    state.send_raw(msg).await.map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
async fn send_activity(
    fingerprint: String,
    room:        String,
    state:       State<'_, signaling::SignalingHandle>,
) -> Result<(), String> {
    let msg = serde_json::to_string(&json!({
        "type": "activity",
        "room": room,
        "from": fingerprint,
    })).map_err(|e| e.to_string())?;
    state.send_raw(msg).await.map_err(|e: anyhow::Error| e.to_string())
}

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
    })).map_err(|e| e.to_string())?;
    state.send_raw(msg).await.map_err(|e: anyhow::Error| e.to_string())
}

// ── Updater commands ───────────────────────────────────────────────────────────

/// Check for an available update. Returns Some({version, notes}) or None.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    Ok(update.map(|u| json!({
        "version":         u.version,
        "current_version": u.current_version,
        "body":            u.body,
        "date":            u.date.map(|d| d.to_string()),
    })))
}

/// Download and install the pending update, emitting progress events.
/// On Windows the app exits automatically when the installer runs.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    use tauri::Emitter;
    use std::sync::{Arc, Mutex};

    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let Some(update) = update else {
        return Err("No update available".to_string());
    };

    // Both closures need their own owned handles
    let app_progress = app.clone();
    let app_finish   = app.clone();
    let downloaded   = Arc::new(Mutex::new(0u64));
    let downloaded2  = downloaded.clone();

    update
        .download_and_install(
            move |chunk, total| {
                let mut dl = downloaded.lock().unwrap();
                *dl += chunk as u64;
                app_progress.emit("update-progress", json!({
                    "downloaded": *dl,
                    "total":      total,
                })).ok();
            },
            move || {
                let _ = downloaded2; // keep alive
                app_finish.emit("update-progress", json!({ "finished": true })).ok();
            },
        )
        .await
        .map_err(|e| e.to_string())
}

// ── App setup ─────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            send_moderation,
            send_activity,
            check_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
