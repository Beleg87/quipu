//! WebSocket client to the Quipu signaling server.
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct SignalingState { pub connected: bool, pub room: Option<String> }

#[derive(Clone)]
pub struct SignalingHandle(Arc<Mutex<SignalingState>>);

impl SignalingHandle {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(SignalingState { connected: false, room: None })))
    }
    pub async fn connect(&self, _url: String, room: String, _fp: String) -> anyhow::Result<()> {
        // TODO Phase 1: real WS connection + join message
        let mut s = self.0.lock().await;
        s.connected = true; s.room = Some(room);
        Ok(())
    }
}
