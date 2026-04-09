//! Real WebSocket client for the Quipu signaling server.
//! Handles join, chat relay, and WebRTC offer/answer/candidate forwarding.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMsg};

// ── Wire types (must match the Go server) ─────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SignalMessage {
    #[serde(rename = "type")]
    pub kind:    String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room:    Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from:    Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to:      Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

// ── Shared state ──────────────────────────────────────────────────────────────

pub struct SignalingState {
    pub connected:   bool,
    pub room:        Option<String>,
    pub fingerprint: Option<String>,
    /// Channel to send outgoing messages into the WS write task
    pub tx:          Option<mpsc::UnboundedSender<String>>,
}

#[derive(Clone)]
pub struct SignalingHandle(pub Arc<Mutex<SignalingState>>);

impl SignalingHandle {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(SignalingState {
            connected:   false,
            room:        None,
            fingerprint: None,
            tx:          None,
        })))
    }

    /// Open a WS connection, send join, and spin up read/write tasks.
    pub async fn connect(
        &self,
        app:         AppHandle,
        url:         String,
        room:        String,
        fingerprint: String,
    ) -> anyhow::Result<()> {
        // Connect
        let (ws_stream, _) = connect_async(&url).await
            .map_err(|e| anyhow::anyhow!("WS connect failed: {e}"))?;

        let (mut write, mut read) = ws_stream.split();

        // Send join message
        let join = serde_json::to_string(&json!({
            "type": "join",
            "room": room,
            "from": fingerprint,
        }))?;
        write.send(WsMsg::Text(join.into())).await
            .map_err(|e| anyhow::anyhow!("join send failed: {e}"))?;

        // Outgoing channel: anything sent here gets written to WS
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        // Write task
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if write.send(WsMsg::Text(msg.into())).await.is_err() { break; }
            }
        });

        // Update state
        {
            let mut state = self.0.lock().await;
            state.connected   = true;
            state.room        = Some(room.clone());
            state.fingerprint = Some(fingerprint.clone());
            state.tx          = Some(tx);
        }

        // Emit connected event to frontend
        app.emit("signaling-status", json!({
            "connected": true,
            "fingerprint": fingerprint,
            "room": room,
        })).ok();

        // Read task — forward every incoming message to the frontend
        let handle    = self.0.clone();
        let app_read  = app.clone();
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(WsMsg::Text(txt)) => {
                        // Parse to Value so Tauri emits it as a proper JSON object,
                        // not a double-encoded string. The frontend receives ev.payload
                        // as an already-parsed JS object — no JSON.parse needed.
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&txt) {
                            app_read.emit("signaling-message", val).ok();
                        }
                    }
                    Ok(WsMsg::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            // Connection dropped — update state and notify UI
            let mut s = handle.lock().await;
            s.connected = false;
            s.tx = None;
            app_read.emit("signaling-status", serde_json::json!({ "connected": false })).ok();
        });

        Ok(())
    }

    /// Send a raw JSON string through the open WS connection.
    pub async fn send_raw(&self, msg: String) -> anyhow::Result<()> {
        let state = self.0.lock().await;
        let tx = state.tx.as_ref()
            .ok_or_else(|| anyhow::anyhow!("not connected"))?;
        tx.send(msg).map_err(|e| anyhow::anyhow!("send failed: {e}"))
    }

    pub async fn is_connected(&self) -> bool {
        self.0.lock().await.connected
    }
}
