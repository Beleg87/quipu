//! Voice pipeline — WebRTC is driven from the frontend JS (RTCPeerConnection).
//! This module exposes Tauri commands needed from the Rust side:
//!   - get_audio_devices  (enumerate input devices for the settings UI)
//!
//! The offer/answer/ICE candidate flow is handled entirely in main.ts via the
//! browser's native RTCPeerConnection API, with Tauri only bridging signals
//! through the signaling handle.
use serde::Serialize;

#[derive(Serialize)]
pub struct AudioDevice {
    pub id:    String,
    pub label: String,
    pub kind:  String,
}

/// Returns audio input devices.
/// On Windows, device enumeration is done via the web APIs in JS
/// (navigator.mediaDevices.enumerateDevices). This stub is a placeholder
/// for future native audio device control (e.g. setting a default device
/// system-wide, or push-to-talk key hooks via a global hotkey plugin).
pub fn list_audio_devices() -> Vec<AudioDevice> {
    vec![] // populated via JS navigator.mediaDevices in Phase 1
}
