mod crypto;
mod signaling;
mod voice;

use tauri::Manager;

#[tauri::command]
fn get_version() -> String { env!("CARGO_PKG_VERSION").to_string() }

#[tauri::command]
fn generate_keypair() -> Result<crypto::KeypairExport, String> {
    crypto::generate_keypair().map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_signaling(
    url: String, room: String, fingerprint: String,
    state: tauri::State<'_, signaling::SignalingHandle>,
) -> Result<(), String> {
    state.connect(url, room, fingerprint).await.map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(signaling::SignalingHandle::new())
        .invoke_handler(tauri::generate_handler![get_version, generate_keypair, connect_signaling])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
