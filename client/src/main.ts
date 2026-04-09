import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import "./styles/main.css";

const appWindow = getCurrentWindow();

// ── App state ─────────────────────────────────────────────────────────────────

interface AppState {
  fingerprint: string;
  serverUrl:   string;
  room:        string;
  connected:   boolean;
  peers:       Map<string, PeerConn>;
}

interface PeerConn {
  fp:  string;
  pc:  RTCPeerConnection;
  muted: boolean;
}

const state: AppState = {
  fingerprint: "",
  serverUrl:   "",
  room:        "quipu-main",
  connected:   false,
  peers:       new Map(),
};

// TURN config — update with your coturn server details
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  // { urls: "turn:YOUR_SERVER:3478", username: "quipu", credential: "YOUR_CRED" },
];

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  const version = await invoke<string>("get_version");
  const app = document.getElementById("app")!;
  app.innerHTML = buildShell(version);

  setupTitleBar();
  setupNav();
  setupChat();
  setupVoice();
  bindSettingsButtons();

  // Register event listeners BEFORE loading identity/config so no events
  // can fire between connection and listener registration
  await listen<any>("signaling-message", (ev) => onSignalingMessage(ev.payload));
  await listen<any>("signaling-status",  (ev) => onSignalingStatus(ev.payload));

  // Load identity + config from persistent store
  await loadIdentity();
  await loadConfig();

  showView("home");
}

// ── Identity ──────────────────────────────────────────────────────────────────

async function loadIdentity() {
  try {
    const kp = await invoke<{ public_key: string; private_key: string; fingerprint: string }>(
      "load_or_create_keypair"
    );
    state.fingerprint = kp.fingerprint;
    setStatus(false, kp.fingerprint);
  } catch (e) {
    console.error("keypair load failed:", e);
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const cfg = await invoke<{ server_url: string; room: string }>("load_config");
    state.serverUrl = cfg.server_url;
    state.room      = cfg.room || "quipu-main";
    // Pre-fill settings inputs if view has been rendered
    fillSettingsInputs();
  } catch (e) {
    console.error("config load failed:", e);
  }
}

function fillSettingsInputs() {
  const urlInput  = document.getElementById("cfg-url")  as HTMLInputElement | null;
  const roomInput = document.getElementById("cfg-room") as HTMLInputElement | null;
  if (urlInput)  urlInput.value  = state.serverUrl;
  if (roomInput) roomInput.value = state.room;
}

// ── Shell HTML ────────────────────────────────────────────────────────────────

function buildShell(version: string): string {
  return `
  <div class="shell">
    <header class="titlebar">
      <div class="titlebar-drag" data-tauri-drag-region>
        <span class="titlebar-logo" data-tauri-drag-region>⬡</span>
        <span class="titlebar-name" data-tauri-drag-region>Quipu</span>
        <span class="titlebar-version" data-tauri-drag-region>v${version}</span>
      </div>
      <div class="titlebar-controls">
        <button class="wbtn minimize" id="btn-minimize" title="Minimize">&#x2013;</button>
        <button class="wbtn maximize" id="btn-maximize" title="Maximize">&#x25A1;</button>
        <button class="wbtn close"    id="btn-close"    title="Close">&#x2715;</button>
      </div>
    </header>

    <div class="body">
      <aside class="sidebar">
        <nav class="nav">
          <button class="nav-btn active" data-view="home">Home</button>
          <button class="nav-btn" data-view="voice">Voice</button>
          <button class="nav-btn" data-view="chat">Chat</button>
          <button class="nav-btn" data-view="settings">Settings</button>
        </nav>
        <div class="identity-badge">
          <span class="dot" id="status-dot"></span>
          <span id="fingerprint-display">Loading…</span>
        </div>
      </aside>

      <main class="content">
        <!-- Home -->
        <div id="view-home" class="view active">
          <h1>Welcome to Quipu</h1>
          <p>Decentralized voice &amp; E2EE chat.<br>No accounts. No servers you don't own.</p>
          <div class="home-actions">
            <button class="btn-primary" id="home-connect-btn">Connect to server</button>
          </div>
          <div class="home-status" id="home-status"></div>
        </div>

        <!-- Voice -->
        <div id="view-voice" class="view voice-view">
          <div class="voice-header">
            <h1>Voice</h1>
            <div class="voice-actions">
              <button class="btn-primary" id="voice-join-btn">Join voice</button>
              <button class="btn-secondary" id="voice-mute-btn" style="display:none">Mute</button>
              <button class="btn-danger"   id="voice-leave-btn" style="display:none">Leave</button>
            </div>
          </div>
          <div class="peer-list" id="peer-list">
            <p class="empty-hint">No peers in voice. Connect to a server first.</p>
          </div>
          <div id="audio-container"></div>
          <select class="device-select" id="mic-select">
            <option value="">Default microphone</option>
          </select>
        </div>

        <!-- Chat -->
        <div id="view-chat" class="view chat-view">
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-form">
            <input class="chat-input" id="chat-input" type="text"
              placeholder="Send a message…" autocomplete="off" maxlength="2000" />
            <button class="chat-send" id="chat-send-btn">Send</button>
          </div>
        </div>

        <!-- Settings -->
        <div id="view-settings" class="view settings-view">
          <h1>Settings</h1>
          <section class="settings-section">
            <h2>Signaling server</h2>
            <label class="field">
              <span>Server URL</span>
              <input id="cfg-url" type="text" placeholder="ws://your.server:8181/ws" spellcheck="false" />
            </label>
            <label class="field">
              <span>Room name</span>
              <input id="cfg-room" type="text" placeholder="quipu-main" spellcheck="false" />
            </label>
            <div class="settings-actions">
              <button class="btn-primary" id="cfg-save-btn">Save &amp; connect</button>
              <button class="btn-secondary" id="cfg-disconnect-btn">Disconnect</button>
            </div>
            <p class="settings-hint" id="cfg-status"></p>
          </section>
          <section class="settings-section">
            <h2>Identity</h2>
            <label class="field">
              <span>Your fingerprint</span>
              <input id="cfg-fp" type="text" readonly />
            </label>
            <p class="settings-hint">This is your permanent identity. Share it with friends so they can verify you.</p>
          </section>
        </div>
      </main>
    </div>
  </div>`;
}

// ── Title bar ─────────────────────────────────────────────────────────────────

function setupTitleBar() {
  document.getElementById("btn-minimize")?.addEventListener("click", () => appWindow.minimize());
  document.getElementById("btn-maximize")?.addEventListener("click", () => appWindow.toggleMaximize());
  document.getElementById("btn-close")?.addEventListener("click",    () => appWindow.close());
}

// ── Navigation ────────────────────────────────────────────────────────────────

function setupNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      showView((btn as HTMLElement).dataset.view!);
    });
  });
}

function showView(name: string) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${name}`)?.classList.add("active");
  if (name === "chat")     { document.getElementById("chat-input")?.focus(); scrollChatToBottom(); }
  if (name === "settings") { fillSettingsInputs(); syncSettingsIdentity(); }
}

function syncSettingsIdentity() {
  const fpInput = document.getElementById("cfg-fp") as HTMLInputElement | null;
  if (fpInput) fpInput.value = state.fingerprint;
}

// ── Status ────────────────────────────────────────────────────────────────────

function setStatus(connected: boolean, label: string) {
  const dot  = document.getElementById("status-dot");
  const disp = document.getElementById("fingerprint-display");
  if (dot)  { dot.classList.toggle("connected", connected); }
  if (disp) { disp.textContent = connected ? label.slice(0, 16) : "Offline"; }
  state.connected = connected;
}

// ── Signaling events (from Rust) ──────────────────────────────────────────────

async function onSignalingStatus(payload: { connected: boolean; fingerprint?: string; room?: string }) {
  setStatus(payload.connected, payload.fingerprint ?? state.fingerprint);
  if (payload.room) state.room = payload.room;

  const homeStatus = document.getElementById("home-status");
  const cfgStatus  = document.getElementById("cfg-status");
  if (payload.connected) {
    const msg = `Connected to ${state.serverUrl} · room: ${state.room}`;
    if (homeStatus) homeStatus.textContent = msg;
    if (cfgStatus)  { cfgStatus.textContent = "Connected"; cfgStatus.className = "settings-hint ok"; }
  } else {
    if (homeStatus) homeStatus.textContent = "Disconnected";
    if (cfgStatus)  { cfgStatus.textContent = "Disconnected"; cfgStatus.className = "settings-hint"; }
    // Clean up peer connections
    state.peers.forEach(p => p.pc.close());
    state.peers.clear();
    renderPeerList();
  }
}

async function onSignalingMessage(msg: any) {
  // msg is already a parsed object — Rust emits serde_json::Value,
  // Tauri deserializes it for us before calling this handler
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "join":      onPeerJoined(msg.from);  break;
    case "leave":     onPeerLeft(msg.from);    break;
    case "chat":      onChatMessage(msg);       break;
    case "offer":     onRtcOffer(msg);         break;
    case "answer":    onRtcAnswer(msg);        break;
    case "candidate": onRtcCandidate(msg);     break;
  }
}

// ── Settings setup ────────────────────────────────────────────────────────────

function bindSettingsButtons() {
  document.getElementById("cfg-save-btn")?.addEventListener("click", async () => {
    const url  = (document.getElementById("cfg-url")  as HTMLInputElement).value.trim();
    const room = (document.getElementById("cfg-room") as HTMLInputElement).value.trim() || "quipu-main";
    const cfgStatus = document.getElementById("cfg-status")!;

    if (!url) { cfgStatus.textContent = "Enter a server URL first."; return; }

    state.serverUrl = url;
    state.room      = room;

    cfgStatus.textContent = "Saving…";
    try {
      await invoke("save_config", { serverUrl: url, room });
      cfgStatus.textContent = "Connecting…";
      await invoke("connect_signaling", { url, room, fingerprint: state.fingerprint });
    } catch (e: any) {
      cfgStatus.textContent = `Error: ${e}`;
      cfgStatus.className   = "settings-hint error";
    }
  });

  document.getElementById("cfg-disconnect-btn")?.addEventListener("click", () => {
    // Disconnect is handled by closing the WS — for now reload the connection state
    setStatus(false, state.fingerprint);
  });

  document.getElementById("home-connect-btn")?.addEventListener("click", () => {
    // Jump to settings if no URL, otherwise try to connect
    if (!state.serverUrl) {
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      document.querySelector('.nav-btn[data-view="settings"]')?.classList.add("active");
      showView("settings");
    } else {
      invoke("connect_signaling", { url: state.serverUrl, room: state.room, fingerprint: state.fingerprint })
        .catch(e => {
          const hs = document.getElementById("home-status");
          if (hs) hs.textContent = `Connection failed: ${e}`;
        });
    }
  });
}

// ── Chat ──────────────────────────────────────────────────────────────────────

interface ChatMessage { id: number; from: string; text: string; ts: Date; }
const chatLog: ChatMessage[] = [];
let chatNextId = 1;

function setupChat() {
  const input   = document.getElementById("chat-input") as HTMLInputElement;
  const sendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;

  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";

    // Show locally immediately
    pushChatMessage({ id: chatNextId++, from: "me", text, ts: new Date() });

    // Always attempt to send — if not connected, send_raw returns an error
    // which we surface in the chat window rather than swallowing silently
    try {
      await invoke("send_chat", { text, fingerprint: state.fingerprint, room: state.room });
    } catch (e: any) {
      pushChatMessage({
        id: chatNextId++,
        from: "system",
        text: `⚠ Not sent: ${e}`,
        ts: new Date(),
      });
    }
  };

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
}

function onChatMessage(msg: any) {
  const text = msg.payload?.text ?? "";
  if (!text) return;
  pushChatMessage({ id: chatNextId++, from: msg.from ?? "?", text, ts: new Date() });
}

function pushChatMessage(msg: ChatMessage) {
  chatLog.push(msg);
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const isSystem = msg.from === "system";
  const isSelf   = msg.from === "me";
  const time     = msg.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const label    = isSystem ? "" : isSelf ? "you" : msg.from.slice(0, 8);
  const el       = document.createElement("div");
  el.className   = `msg ${isSystem ? "msg-system" : isSelf ? "msg-self" : "msg-peer"}`;
  el.innerHTML   = isSystem
    ? `<span class="msg-body">${escapeHtml(msg.text)}</span>`
    : `<span class="msg-meta">${label} · ${time}</span><span class="msg-body">${escapeHtml(msg.text)}</span>`;
  container.appendChild(el);
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const el = document.getElementById("chat-messages");
  if (el) el.scrollTop = el.scrollHeight;
}

// ── Voice / WebRTC ────────────────────────────────────────────────────────────

let localStream: MediaStream | null = null;
let inVoice = false;

function setupVoice() {
  document.getElementById("voice-join-btn")?.addEventListener("click",  joinVoice);
  document.getElementById("voice-mute-btn")?.addEventListener("click",  toggleMute);
  document.getElementById("voice-leave-btn")?.addEventListener("click", leaveVoice);

  // Enumerate microphones
  navigator.mediaDevices?.enumerateDevices().then(devices => {
    const sel = document.getElementById("mic-select") as HTMLSelectElement;
    if (!sel) return;
    devices.filter(d => d.kind === "audioinput").forEach(d => {
      const opt = document.createElement("option");
      opt.value       = d.deviceId;
      opt.textContent = d.label || `Microphone ${sel.options.length}`;
      sel.appendChild(opt);
    });
  }).catch(() => {});
}

async function joinVoice() {
  if (!state.connected) {
    alert("Connect to a signaling server first (Settings tab).");
    return;
  }
  if (inVoice) return;

  const sel = document.getElementById("mic-select") as HTMLSelectElement;
  const constraints: MediaStreamConstraints = {
    audio: sel.value ? { deviceId: { exact: sel.value } } : true,
    video: false,
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    alert(`Microphone access denied: ${e}`);
    return;
  }

  inVoice = true;
  document.getElementById("voice-join-btn")!.style.display  = "none";
  document.getElementById("voice-mute-btn")!.style.display  = "inline-flex";
  document.getElementById("voice-leave-btn")!.style.display = "inline-flex";

  // Create peer connections for already-present peers
  state.peers.forEach((_, fp) => createOrGetPC(fp, true));
}

async function leaveVoice() {
  inVoice = false;
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;

  state.peers.forEach(p => p.pc.close());
  state.peers.clear();

  document.getElementById("audio-container")!.innerHTML   = "";
  document.getElementById("voice-join-btn")!.style.display  = "inline-flex";
  document.getElementById("voice-mute-btn")!.style.display  = "none";
  document.getElementById("voice-leave-btn")!.style.display = "none";
  renderPeerList();
}

function toggleMute() {
  if (!localStream) return;
  const btn   = document.getElementById("voice-mute-btn")!;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  btn.textContent = track.enabled ? "Mute" : "Unmute";
  btn.classList.toggle("btn-danger", !track.enabled);
}

// ── Peer lifecycle ────────────────────────────────────────────────────────────

function onPeerJoined(fp: string) {
  if (!fp || fp === state.fingerprint) return;
  if (!state.peers.has(fp)) {
    state.peers.set(fp, { fp, pc: null as any, muted: false });
  }
  renderPeerList();
  // If we're already in voice, initiate an offer to the new peer
  if (inVoice) createOrGetPC(fp, true);
}

function onPeerLeft(fp: string) {
  const peer = state.peers.get(fp);
  if (peer) { peer.pc?.close(); state.peers.delete(fp); }
  document.getElementById(`audio-${fp}`)?.remove();
  renderPeerList();
}

function renderPeerList() {
  const list = document.getElementById("peer-list");
  if (!list) return;
  if (state.peers.size === 0) {
    list.innerHTML = `<p class="empty-hint">${state.connected ? "No peers in room." : "Not connected."}</p>`;
    return;
  }
  list.innerHTML = "";
  state.peers.forEach((peer) => {
    const el = document.createElement("div");
    el.className = "peer-card";
    el.id        = `peer-${peer.fp}`;
    el.innerHTML = `
      <span class="peer-dot"></span>
      <span class="peer-fp">${peer.fp.slice(0, 16)}</span>
    `;
    list.appendChild(el);
  });
}

// ── WebRTC peer connection ────────────────────────────────────────────────────

function createOrGetPC(remoteFp: string, isInitiator: boolean): RTCPeerConnection {
  const existing = state.peers.get(remoteFp);
  if (existing?.pc) return existing.pc;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add local tracks
  localStream?.getTracks().forEach(track => {
    localStream && pc.addTrack(track, localStream);
  });

  // Remote audio
  pc.ontrack = (ev) => {
    const container = document.getElementById("audio-container")!;
    let audio = document.getElementById(`audio-${remoteFp}`) as HTMLAudioElement | null;
    if (!audio) {
      audio = document.createElement("audio");
      audio.id       = `audio-${remoteFp}`;
      audio.autoplay = true;
      container.appendChild(audio);
    }
    audio.srcObject = ev.streams[0];
  };

  // ICE candidates → send through signaling
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    invoke("send_signal", {
      kind:        "candidate",
      to:          remoteFp,
      payload:     ev.candidate.toJSON(),
      fingerprint: state.fingerprint,
      room:        state.room,
    }).catch(console.error);
  };

  // Store the PC
  state.peers.set(remoteFp, { fp: remoteFp, pc, muted: false });

  // Initiate offer if we're the caller
  if (isInitiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      invoke("send_signal", {
        kind:        "offer",
        to:          remoteFp,
        payload:     offer,
        fingerprint: state.fingerprint,
        room:        state.room,
      }).catch(console.error);
    });
  }

  return pc;
}

async function onRtcOffer(msg: any) {
  if (!inVoice || !localStream) return;
  const pc = createOrGetPC(msg.from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await invoke("send_signal", {
    kind:        "answer",
    to:          msg.from,
    payload:     answer,
    fingerprint: state.fingerprint,
    room:        state.room,
  });
}

async function onRtcAnswer(msg: any) {
  const peer = state.peers.get(msg.from);
  if (!peer?.pc) return;
  await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
}

async function onRtcCandidate(msg: any) {
  const peer = state.peers.get(msg.from);
  if (!peer?.pc) return;
  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(msg.payload));
  } catch (e) {
    console.warn("addIceCandidate failed:", e);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();
