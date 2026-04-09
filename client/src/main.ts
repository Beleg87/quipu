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
  nicknames:   Map<string, string>;
  myNickname:  string;
  activeChannel: string;
}

interface PeerConn {
  fp: string; pc: RTCPeerConnection; muted: boolean;
}

interface StoredMessage {
  id: number; from: string; text: string; ts: string;
}

const state: AppState = {
  fingerprint: "",
  serverUrl:   "",
  room:        "quipu-main",
  connected:   false,
  peers:       new Map(),
  nicknames:   new Map(),
  myNickname:  "",
  activeChannel: "general",
};

// Built-in channels always present. Users can add more.
const DEFAULT_CHANNELS = ["general", "voice-text", "random"];

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// ── Channel / message persistence ─────────────────────────────────────────────

function channelKey(ch: string) { return `quipu-chat-${state.room}-${ch}`; }
function channelListKey()       { return `quipu-channels-${state.room}`; }

function getChannels(): string[] {
  try {
    const stored = localStorage.getItem(channelListKey());
    const list   = stored ? JSON.parse(stored) as string[] : [];
    const merged = [...new Set([...DEFAULT_CHANNELS, ...list])];
    saveChannelList(merged);
    return merged;
  } catch { return [...DEFAULT_CHANNELS]; }
}

function saveChannelList(channels: string[]) {
  try { localStorage.setItem(channelListKey(), JSON.stringify(channels)); } catch {}
}

function addChannel(name: string): boolean {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
  if (!slug) return false;
  const channels = getChannels();
  if (channels.includes(slug)) return false;
  channels.push(slug);
  saveChannelList(channels);
  return true;
}

function removeChannel(name: string) {
  if (DEFAULT_CHANNELS.includes(name)) return;
  const channels = getChannels().filter(c => c !== name);
  saveChannelList(channels);
  try { localStorage.removeItem(channelKey(name)); } catch {}
}

function loadMessages(channel: string): StoredMessage[] {
  try {
    const raw = localStorage.getItem(channelKey(channel));
    return raw ? JSON.parse(raw) as StoredMessage[] : [];
  } catch { return []; }
}

function saveMessage(channel: string, msg: StoredMessage) {
  try {
    const msgs = loadMessages(channel);
    msgs.push(msg);
    // Keep last 500 messages per channel
    if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
    localStorage.setItem(channelKey(channel), JSON.stringify(msgs));
  } catch {}
}

let chatNextId = 1;

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

  await listen<any>("signaling-message", (ev) => onSignalingMessage(ev.payload));
  await listen<any>("signaling-status",  (ev) => onSignalingStatus(ev.payload));

  await loadIdentity();
  await loadConfig();

  showView("home");
}

async function loadIdentity() {
  try {
    const kp = await invoke<{ fingerprint: string }>("load_or_create_keypair");
    state.fingerprint = kp.fingerprint;
    setStatus(false, kp.fingerprint);
  } catch (e) { console.error("keypair load failed:", e); }
}

async function loadConfig() {
  try {
    const cfg = await invoke<{ server_url: string; room: string; nickname: string }>("load_config");
    state.serverUrl  = cfg.server_url;
    state.room       = cfg.room || "quipu-main";
    state.myNickname = cfg.nickname || "";
    fillSettingsInputs();
  } catch (e) { console.error("config load failed:", e); }
}

function fillSettingsInputs() {
  const urlInput      = document.getElementById("cfg-url")      as HTMLInputElement | null;
  const roomInput     = document.getElementById("cfg-room")     as HTMLInputElement | null;
  const nicknameInput = document.getElementById("cfg-nickname") as HTMLInputElement | null;
  if (urlInput)      urlInput.value      = state.serverUrl;
  if (roomInput)     roomInput.value     = state.room;
  if (nicknameInput) nicknameInput.value = state.myNickname;
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
        <button class="wbtn minimize" id="btn-minimize">&#x2013;</button>
        <button class="wbtn maximize" id="btn-maximize">&#x25A1;</button>
        <button class="wbtn close"    id="btn-close">&#x2715;</button>
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
              <button class="btn-primary"   id="voice-join-btn">Join voice</button>
              <button class="btn-secondary" id="voice-mute-btn"  style="display:none">Mute</button>
              <button class="btn-danger"    id="voice-leave-btn" style="display:none">Leave</button>
            </div>
          </div>
          <div class="peer-list" id="peer-list"><p class="empty-hint">Not connected.</p></div>
          <div id="audio-container"></div>
          <select class="device-select" id="mic-select">
            <option value="">Default microphone</option>
          </select>
        </div>

        <!-- Chat — two-column layout: channel list + message pane -->
        <div id="view-chat" class="view chat-view">
          <div class="chat-sidebar">
            <div class="chat-sidebar-header">
              <span>Channels</span>
              <button class="btn-icon" id="add-channel-btn" title="New channel">+</button>
            </div>
            <div class="channel-list" id="channel-list"></div>
          </div>
          <div class="chat-main">
            <div class="chat-status-bar" id="chat-status-bar">Not connected</div>
            <div class="chat-messages" id="chat-messages"></div>
            <div class="chat-form">
              <input class="chat-input" id="chat-input" type="text"
                placeholder="Send a message…" autocomplete="off" maxlength="2000" />
              <button class="chat-send" id="chat-send-btn">Send</button>
            </div>
          </div>
        </div>

        <!-- Settings -->
        <div id="view-settings" class="view settings-view">
          <h1>Settings</h1>
          <section class="settings-section">
            <h2>Signaling server</h2>
            <label class="field"><span>Server URL</span>
              <input id="cfg-url" type="text" placeholder="ws://your.server:8181/ws" spellcheck="false" /></label>
            <label class="field"><span>Room name</span>
              <input id="cfg-room" type="text" placeholder="quipu-main" spellcheck="false" /></label>
            <div class="settings-actions">
              <button class="btn-primary"   id="cfg-save-btn">Save &amp; connect</button>
              <button class="btn-secondary" id="cfg-disconnect-btn">Disconnect</button>
            </div>
            <p class="settings-hint" id="cfg-status"></p>
          </section>
          <section class="settings-section">
            <h2>Identity</h2>
            <label class="field"><span>Your nickname</span>
              <input id="cfg-nickname" type="text" placeholder="e.g. Beleg" spellcheck="false" maxlength="32" /></label>
            <label class="field"><span>Your fingerprint</span>
              <input id="cfg-fp" type="text" readonly /></label>
            <div class="settings-actions">
              <button class="btn-primary" id="cfg-save-identity-btn">Save nickname</button>
            </div>
            <p class="settings-hint">Share your fingerprint with friends so they can identify you.</p>
          </section>
          <section class="settings-section">
            <h2>Connected peers</h2>
            <div id="peer-nickname-list" class="peer-nickname-list">
              <p class="settings-hint">No peers connected.</p>
            </div>
          </section>
          <section class="settings-section">
            <h2>Updates</h2>
            <div class="settings-actions">
              <button class="btn-primary" id="update-check-btn">Check for updates</button>
            </div>
            <div id="update-status" class="update-status"></div>
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
  if (name === "chat")     { renderChannelList(); switchChannel(state.activeChannel); }
  if (name === "settings") { fillSettingsInputs(); syncSettingsIdentity(); renderPeerNicknameList(); }
}

function syncSettingsIdentity() {
  const fpInput = document.getElementById("cfg-fp") as HTMLInputElement | null;
  if (fpInput) fpInput.value = state.fingerprint;
}

// ── Status ────────────────────────────────────────────────────────────────────

function setStatus(connected: boolean, label: string) {
  const dot  = document.getElementById("status-dot");
  const disp = document.getElementById("fingerprint-display");
  if (dot)  dot.classList.toggle("connected", connected);
  if (disp) disp.textContent = connected ? (state.myNickname || label.slice(0, 16)) : "Offline";
  state.connected = connected;
  updateChatStatusBar();
}

function updateChatStatusBar() {
  const bar = document.getElementById("chat-status-bar");
  if (!bar) return;
  if (state.connected) {
    bar.textContent = `Connected · room: ${state.room} · ${state.peers.size} peer(s)`;
    bar.className = "chat-status-bar ok";
  } else {
    bar.textContent = "Not connected — go to Settings to connect";
    bar.className = "chat-status-bar";
  }
}

// ── Signaling events ──────────────────────────────────────────────────────────

async function onSignalingStatus(payload: { connected: boolean; fingerprint?: string; room?: string }) {
  if (payload.room) state.room = payload.room;
  setStatus(payload.connected, payload.fingerprint ?? state.fingerprint);

  const homeStatus = document.getElementById("home-status");
  const cfgStatus  = document.getElementById("cfg-status");
  if (payload.connected) {
    if (homeStatus) homeStatus.textContent = `Connected · ${state.serverUrl} · room: ${state.room}`;
    if (cfgStatus)  { cfgStatus.textContent = "Connected"; cfgStatus.className = "settings-hint ok"; }
    broadcastNickname();
  } else {
    if (homeStatus) homeStatus.textContent = "Disconnected";
    if (cfgStatus)  { cfgStatus.textContent = "Disconnected"; cfgStatus.className = "settings-hint"; }
    if (inVoice) leaveVoice();
    state.peers.forEach(p => p.pc?.close());
    state.peers.clear();
    renderPeerList();
    renderPeerNicknameList();
  }
}

async function onSignalingMessage(msg: any) {
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

// ── Settings ──────────────────────────────────────────────────────────────────

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
      await invoke("save_config", { serverUrl: url, room, nickname: state.myNickname });
      cfgStatus.textContent = "Connecting…";
      await invoke("connect_signaling", { url, room, fingerprint: state.fingerprint });
    } catch (e: any) {
      cfgStatus.textContent = `Error: ${e}`;
      cfgStatus.className   = "settings-hint error";
    }
  });

  document.getElementById("cfg-disconnect-btn")?.addEventListener("click", () => {
    setStatus(false, state.fingerprint);
    if (inVoice) leaveVoice();
    state.peers.forEach(p => p.pc?.close());
    state.peers.clear();
    renderPeerList();
    renderPeerNicknameList();
  });

  document.getElementById("cfg-save-identity-btn")?.addEventListener("click", async () => {
    const nicknameInput = document.getElementById("cfg-nickname") as HTMLInputElement;
    state.myNickname = nicknameInput.value.trim().slice(0, 32);
    try {
      await invoke("save_config", { serverUrl: state.serverUrl, room: state.room, nickname: state.myNickname });
      setStatus(state.connected, state.fingerprint);
      if (state.connected) broadcastNickname();
    } catch (e) { console.error("save nickname failed:", e); }
  });

  document.getElementById("home-connect-btn")?.addEventListener("click", () => {
    if (!state.serverUrl) {
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      document.querySelector('.nav-btn[data-view="settings"]')?.classList.add("active");
      showView("settings");
    } else {
      invoke("connect_signaling", { url: state.serverUrl, room: state.room, fingerprint: state.fingerprint })
        .catch(e => { const hs = document.getElementById("home-status"); if (hs) hs.textContent = `Failed: ${e}`; });
    }
  });

  document.getElementById("update-check-btn")?.addEventListener("click", checkForUpdates);
}

// ── Nicknames ─────────────────────────────────────────────────────────────────

function displayName(fp: string): string {
  return state.nicknames.get(fp) || fp.slice(0, 8);
}

function broadcastNickname() {
  if (!state.connected || !state.myNickname) return;
  invoke("send_chat", { text: `__nick:${state.myNickname}`, fingerprint: state.fingerprint, room: state.room }).catch(() => {});
}

function renderPeerNicknameList() {
  const list = document.getElementById("peer-nickname-list");
  if (!list) return;
  if (state.peers.size === 0) { list.innerHTML = `<p class="settings-hint">No peers connected.</p>`; return; }
  list.innerHTML = "";
  state.peers.forEach((peer) => {
    const div = document.createElement("div");
    div.className = "peer-nick-row";
    div.innerHTML = `
      <span class="peer-nick-fp">${peer.fp.slice(0, 16)}</span>
      <input class="peer-nick-input" type="text" placeholder="Set nickname…"
        value="${escapeHtml(state.nicknames.get(peer.fp) || "")}" maxlength="32" data-fp="${peer.fp}" />
      <button class="btn-secondary peer-nick-save" data-fp="${peer.fp}">Save</button>`;
    list.appendChild(div);
  });
  list.querySelectorAll(".peer-nick-save").forEach(btn => {
    btn.addEventListener("click", () => {
      const fp    = (btn as HTMLElement).dataset.fp!;
      const input = list.querySelector(`input[data-fp="${fp}"]`) as HTMLInputElement;
      if (input) { state.nicknames.set(fp, input.value.trim().slice(0, 32)); renderPeerList(); updateChatStatusBar(); }
    });
  });
}

// ── Updates ───────────────────────────────────────────────────────────────────

function setUpdateStatus(html: string, cls = "") {
  const el = document.getElementById("update-status");
  if (el) { el.innerHTML = html; el.className = `update-status ${cls}`; }
}

async function checkForUpdates() {
  const btn = document.getElementById("update-check-btn") as HTMLButtonElement;
  btn.disabled = true; setUpdateStatus("Checking…");
  try {
    const update = await invoke<{ version: string; body: string | null } | null>("check_update");
    if (!update) { setUpdateStatus("✓ You're on the latest version.", "ok"); btn.disabled = false; return; }
    setUpdateStatus(`<strong>Update available: v${update.version}</strong>
      ${update.body ? `<p class="update-notes">${escapeHtml(update.body)}</p>` : ""}
      <div class="settings-actions" style="margin-top:0.75rem">
        <button class="btn-primary" id="update-install-btn">Install update</button>
      </div><p id="update-dl-status" class="settings-hint"></p>`);
    document.getElementById("update-install-btn")?.addEventListener("click", installUpdate);
  } catch (e: any) { setUpdateStatus(`⚠ Update check failed: ${e}`, "error"); btn.disabled = false; }
}

async function installUpdate() {
  const installBtn = document.getElementById("update-install-btn") as HTMLButtonElement;
  const dlStatus   = document.getElementById("update-dl-status")!;
  installBtn.disabled = true; dlStatus.textContent = "Starting download…";
  const { listen: listenEv } = await import("@tauri-apps/api/event");
  const unlisten = await listenEv<{ downloaded?: number; total?: number | null; finished?: boolean }>(
    "update-progress", (ev) => {
      const d = ev.payload;
      if (d.finished) { dlStatus.textContent = "Installing… app will restart shortly."; }
      else if (d.downloaded != null) {
        const pct = d.total ? Math.round((d.downloaded / d.total) * 100) : "…";
        dlStatus.textContent = `Downloading: ${(d.downloaded / 1024 / 1024).toFixed(1)} MB (${pct}%)`;
      }
    });
  try { await invoke("install_update"); unlisten(); }
  catch (e: any) { unlisten(); dlStatus.textContent = `Install failed: ${e}`; installBtn.disabled = false; }
}

// ── Chat channels ─────────────────────────────────────────────────────────────

function renderChannelList() {
  const list = document.getElementById("channel-list");
  if (!list) return;
  const channels = getChannels();
  list.innerHTML = "";
  channels.forEach(ch => {
    const row = document.createElement("div");
    row.className = `channel-item ${ch === state.activeChannel ? "active" : ""}`;
    row.dataset.ch = ch;
    const isDefault = DEFAULT_CHANNELS.includes(ch);
    row.innerHTML = `
      <span class="channel-hash">#</span>
      <span class="channel-name">${escapeHtml(ch)}</span>
      ${isDefault ? "" : `<button class="channel-delete" data-ch="${ch}" title="Delete channel">×</button>`}`;
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("channel-delete")) return;
      switchChannel(ch);
    });
    list.appendChild(row);
  });
  // Wire delete buttons
  list.querySelectorAll(".channel-delete").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const ch = (btn as HTMLElement).dataset.ch!;
      if (!confirm(`Delete channel #${ch} and all its history?`)) return;
      removeChannel(ch);
      if (state.activeChannel === ch) switchChannel("general");
      else renderChannelList();
    });
  });
  // Add channel button
  document.getElementById("add-channel-btn")?.addEventListener("click", () => {
    const name = prompt("Channel name (letters, numbers, hyphens):");
    if (!name) return;
    if (addChannel(name)) {
      renderChannelList();
      switchChannel(name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32));
    } else {
      alert("Channel already exists or invalid name.");
    }
  });
}

function switchChannel(ch: string) {
  state.activeChannel = ch;
  // Update active state in list
  document.querySelectorAll(".channel-item").forEach(el => {
    el.classList.toggle("active", (el as HTMLElement).dataset.ch === ch);
  });
  // Reload messages for this channel
  const container = document.getElementById("chat-messages")!;
  if (!container) return;
  container.innerHTML = "";
  const msgs = loadMessages(ch);
  if (msgs.length === 0) {
    container.innerHTML = `<p class="empty-hint">No messages yet.</p>`;
  } else {
    msgs.forEach(m => renderChatMessage({ ...m, ts: new Date(m.ts) }));
  }
  scrollChatToBottom();
  document.getElementById("chat-input")?.focus();
}

function setupChat() {
  const input   = document.getElementById("chat-input") as HTMLInputElement;
  const sendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement;
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    // Remove empty hint if present
    const container = document.getElementById("chat-messages")!;
    const hint = container.querySelector(".empty-hint");
    if (hint) hint.remove();
    const msg = { id: chatNextId++, from: "me", text, ts: new Date() };
    saveMessage(state.activeChannel, { ...msg, ts: msg.ts.toISOString() });
    renderChatMessage(msg);
    try {
      // Prefix message with channel so receiver routes it correctly
      await invoke("send_chat", {
        text: `__ch:${state.activeChannel}:${text}`,
        fingerprint: state.fingerprint,
        room: state.room,
      });
    } catch (e: any) {
      renderChatMessage({ id: chatNextId++, from: "system", text: `⚠ Not sent: ${e}`, ts: new Date() });
    }
  };
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
}

function onChatMessage(msg: any) {
  const rawText = msg.payload?.text ?? "";
  if (!rawText) return;

  // Nickname announcement
  if (rawText.startsWith("__nick:")) {
    const nick = rawText.slice(7).trim();
    if (msg.from && nick) {
      state.nicknames.set(msg.from, nick.slice(0, 32));
      renderPeerList(); renderPeerNicknameList(); updateChatStatusBar();
    }
    return;
  }

  // Channel-prefixed message
  let channel = "general";
  let text    = rawText;
  if (rawText.startsWith("__ch:")) {
    const parts = rawText.slice(5).split(":");
    channel = parts[0] || "general";
    text    = parts.slice(1).join(":");
  }

  if (!text) return;
  const chatMsg = { id: chatNextId++, from: msg.from ?? "?", text, ts: new Date() };
  saveMessage(channel, { ...chatMsg, ts: chatMsg.ts.toISOString() });

  // Only render if this channel is currently active
  if (channel === state.activeChannel) {
    const container = document.getElementById("chat-messages")!;
    const hint = container?.querySelector(".empty-hint");
    if (hint) hint.remove();
    renderChatMessage(chatMsg);
  } else {
    // Badge the channel with unread indicator
    const item = document.querySelector(`.channel-item[data-ch="${channel}"]`);
    if (item) item.classList.add("unread");
  }
}

function renderChatMessage(msg: { id: number; from: string; text: string; ts: Date }) {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const isSystem = msg.from === "system";
  const isSelf   = msg.from === "me";
  const time     = msg.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const label    = isSystem ? "" : isSelf ? (state.myNickname || "you") : displayName(msg.from);
  const el       = document.createElement("div");
  el.className   = `msg ${isSystem ? "msg-system" : isSelf ? "msg-self" : "msg-peer"}`;
  el.innerHTML   = isSystem
    ? `<span class="msg-body">${escapeHtml(msg.text)}</span>`
    : `<span class="msg-meta">${escapeHtml(label)} · ${time}</span><span class="msg-body">${escapeHtml(msg.text)}</span>`;
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
  navigator.mediaDevices?.enumerateDevices().then(devices => {
    const sel = document.getElementById("mic-select") as HTMLSelectElement;
    if (!sel) return;
    devices.filter(d => d.kind === "audioinput").forEach(d => {
      const opt = document.createElement("option");
      opt.value = d.deviceId; opt.textContent = d.label || `Microphone ${sel.options.length}`;
      sel.appendChild(opt);
    });
  }).catch(() => {});
}

async function joinVoice() {
  if (!state.connected) { alert("Connect to a signaling server first (Settings tab)."); return; }
  if (inVoice) return;
  const sel = document.getElementById("mic-select") as HTMLSelectElement;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: sel.value ? { deviceId: { exact: sel.value } } : true, video: false,
    });
  } catch (e) { alert(`Microphone access denied: ${e}`); return; }
  inVoice = true;
  document.getElementById("voice-join-btn")!.style.display  = "none";
  document.getElementById("voice-mute-btn")!.style.display  = "inline-flex";
  document.getElementById("voice-leave-btn")!.style.display = "inline-flex";
  state.peers.forEach((_, fp) => createOrGetPC(fp, true));
}

function leaveVoice() {
  inVoice = false;
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  state.peers.forEach(p => {
    p.pc?.close();
    state.peers.set(p.fp, { ...p, pc: null as any });
  });
  document.getElementById("audio-container")!.innerHTML = "";
  document.getElementById("voice-join-btn")!.style.display  = "inline-flex";
  document.getElementById("voice-mute-btn")!.style.display  = "none";
  document.getElementById("voice-leave-btn")!.style.display = "none";
  renderPeerList();
}

function toggleMute() {
  if (!localStream) return;
  const btn = document.getElementById("voice-mute-btn")!;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  btn.textContent = track.enabled ? "Mute" : "Unmute";
  btn.classList.toggle("btn-danger", !track.enabled);
}

// ── Peer lifecycle ────────────────────────────────────────────────────────────

function onPeerJoined(fp: string) {
  if (!fp || fp === state.fingerprint) return;
  if (!state.peers.has(fp)) state.peers.set(fp, { fp, pc: null as any, muted: false });
  renderPeerList(); renderPeerNicknameList(); updateChatStatusBar();
  if (state.connected && state.myNickname) broadcastNickname();
  if (inVoice) createOrGetPC(fp, true);
}

function onPeerLeft(fp: string) {
  const peer = state.peers.get(fp);
  if (peer) { peer.pc?.close(); state.peers.delete(fp); }
  document.getElementById(`audio-${fp}`)?.remove();
  renderPeerList(); renderPeerNicknameList(); updateChatStatusBar();
  const name = displayName(fp);
  const msg = { id: chatNextId++, from: "system", text: `${name} left`, ts: new Date() };
  // Show in all channels
  if (document.getElementById("view-chat")?.classList.contains("active")) {
    const container = document.getElementById("chat-messages");
    const hint = container?.querySelector(".empty-hint");
    if (hint) hint.remove();
    renderChatMessage(msg);
  }
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
    el.className = "peer-card"; el.id = `peer-${peer.fp}`;
    el.innerHTML = `
      <span class="peer-dot ${inVoice && peer.pc ? "in-voice" : ""}"></span>
      <span class="peer-name">${escapeHtml(displayName(peer.fp))}</span>
      <span class="peer-fp-small">${peer.fp.slice(0, 8)}</span>`;
    list.appendChild(el);
  });
}

// ── WebRTC ────────────────────────────────────────────────────────────────────

function createOrGetPC(remoteFp: string, isInitiator: boolean): RTCPeerConnection {
  const existing = state.peers.get(remoteFp);
  if (existing?.pc && existing.pc.connectionState !== "closed" && existing.pc.connectionState !== "failed") {
    return existing.pc;
  }
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream?.getTracks().forEach(track => { localStream && pc.addTrack(track, localStream); });
  pc.ontrack = (ev) => {
    const container = document.getElementById("audio-container")!;
    let audio = document.getElementById(`audio-${remoteFp}`) as HTMLAudioElement | null;
    if (!audio) { audio = document.createElement("audio"); audio.id = `audio-${remoteFp}`; audio.autoplay = true; container.appendChild(audio); }
    audio.srcObject = ev.streams[0];
  };
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    invoke("send_signal", { kind: "candidate", to: remoteFp, payload: ev.candidate.toJSON(), fingerprint: state.fingerprint, room: state.room }).catch(console.error);
  };
  pc.onconnectionstatechange = () => renderPeerList();
  state.peers.set(remoteFp, { fp: remoteFp, pc, muted: false });
  if (isInitiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      invoke("send_signal", { kind: "offer", to: remoteFp, payload: offer, fingerprint: state.fingerprint, room: state.room }).catch(console.error);
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
  await invoke("send_signal", { kind: "answer", to: msg.from, payload: answer, fingerprint: state.fingerprint, room: state.room });
}

async function onRtcAnswer(msg: any) {
  const peer = state.peers.get(msg.from);
  if (!peer?.pc) return;
  await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
}

async function onRtcCandidate(msg: any) {
  const peer = state.peers.get(msg.from);
  if (!peer?.pc) return;
  try { await peer.pc.addIceCandidate(new RTCIceCandidate(msg.payload)); }
  catch (e) { console.warn("addIceCandidate failed:", e); }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();
