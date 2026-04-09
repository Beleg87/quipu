import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import "./styles/main.css";

const appWindow = getCurrentWindow();

// ── Types ─────────────────────────────────────────────────────────────────────

interface AppState {
  fingerprint:   string;
  serverUrl:     string;
  myNickname:    string;
  connected:     boolean;
  peers:         Map<string, PeerConn>;
  nicknames:     Map<string, string>;
  activeVoice:   string | null;   // currently joined voice channel name
  activeText:    string;          // currently viewed text channel
  textChannels:  string[];
  voiceChannels: string[];
}

interface PeerConn {
  fp: string; pc: RTCPeerConnection; muted: boolean;
}

interface StoredMessage {
  id: number; from: string; text: string; ts: string;
}

const state: AppState = {
  fingerprint:   "",
  serverUrl:     "",
  myNickname:    "",
  connected:     false,
  peers:         new Map(),
  nicknames:     new Map(),
  activeVoice:   null,
  activeText:    "general",
  textChannels:  ["general", "random"],
  voiceChannels: ["Main", "Gaming", "AFK"],
};

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
let localStream: MediaStream | null = null;
let chatNextId = 1;

// Separate set tracking fingerprints of peers in the current voice channel
const voicePeers: Set<string> = new Set();

// ── Persistence helpers ───────────────────────────────────────────────────────

// Each text channel's messages are stored locally, keyed by server+channel
function msgKey(ch: string) {
  const base = state.serverUrl.replace(/[^a-z0-9]/gi, "_").slice(0, 40);
  return `quipu_msgs_${base}_${ch}`;
}
function configKey() { return "quipu_channel_config"; }

function saveChannelConfig() {
  try {
    localStorage.setItem(configKey(), JSON.stringify({
      textChannels:  state.textChannels,
      voiceChannels: state.voiceChannels,
    }));
  } catch {}
}

function loadChannelConfig() {
  try {
    const raw = localStorage.getItem(configKey());
    if (!raw) return;
    const cfg = JSON.parse(raw);
    if (cfg.textChannels  && Array.isArray(cfg.textChannels))  state.textChannels  = cfg.textChannels;
    if (cfg.voiceChannels && Array.isArray(cfg.voiceChannels)) state.voiceChannels = cfg.voiceChannels;
  } catch {}
}

function loadMsgs(ch: string): StoredMessage[] {
  try { const r = localStorage.getItem(msgKey(ch)); return r ? JSON.parse(r) : []; } catch { return []; }
}

function saveMsg(ch: string, msg: StoredMessage) {
  try {
    const msgs = loadMsgs(ch);
    msgs.push(msg);
    if (msgs.length > 500) msgs.splice(0, msgs.length - 500);
    localStorage.setItem(msgKey(ch), JSON.stringify(msgs));
  } catch {}
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  const version = await invoke<string>("get_version");
  const app = document.getElementById("app")!;
  app.innerHTML = buildShell(version);

  setupTitleBar();
  setupSidebar();

  await listen<any>("signaling-message", (ev) => onSignalingMessage(ev.payload));
  await listen<any>("signaling-status",  (ev) => onSignalingStatus(ev.payload));

  await loadIdentity();
  await loadConfig();
  loadChannelConfig();

  renderSidebar();
  showText(state.activeText);
}

async function loadIdentity() {
  try {
    const kp = await invoke<{ fingerprint: string }>("load_or_create_keypair");
    state.fingerprint = kp.fingerprint;
    updateStatusBadge();
  } catch (e) { console.error("keypair load failed:", e); }
}

async function loadConfig() {
  try {
    const cfg = await invoke<{ server_url: string; room: string; nickname: string }>("load_config");
    state.serverUrl  = cfg.server_url;
    state.myNickname = cfg.nickname || "";
    updateStatusBadge();
    prefillSettings();
  } catch (e) { console.error("config load failed:", e); }
}

// ── Shell ─────────────────────────────────────────────────────────────────────

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

      <!-- Sidebar: channels + identity badge -->
      <aside class="sidebar">
        <div class="sidebar-server">
          <span class="server-name" id="server-name">Quipu</span>
          <button class="sidebar-settings-btn" id="open-settings-btn" title="Settings">⚙</button>
        </div>

        <div class="channel-group">
          <div class="channel-group-header">
            <span>Text channels</span>
            <button class="ch-add-btn" id="add-text-ch-btn" title="Add text channel">+</button>
          </div>
          <div id="text-channel-list"></div>
        </div>

        <div class="channel-group">
          <div class="channel-group-header">
            <span>Voice channels</span>
            <button class="ch-add-btn" id="add-voice-ch-btn" title="Add voice channel">+</button>
          </div>
          <div id="voice-channel-list"></div>
        </div>

        <div class="sidebar-bottom">
          <div class="identity-badge">
            <span class="dot" id="status-dot"></span>
            <span id="identity-label">Offline</span>
          </div>
          <div class="voice-status" id="voice-status" style="display:none">
            <span id="voice-status-label"></span>
            <button class="voice-disconnect-btn" id="voice-leave-btn" title="Leave voice">&#x2715;</button>
          </div>
        </div>
      </aside>

      <!-- Main content area — swapped by showText / showSettings -->
      <main class="content" id="main-content">
        <!-- injected dynamically -->
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

// ── Sidebar ───────────────────────────────────────────────────────────────────

function setupSidebar() {
  document.getElementById("open-settings-btn")?.addEventListener("click", showSettings);
  document.getElementById("add-text-ch-btn")?.addEventListener("click",  addTextChannel);
  document.getElementById("add-voice-ch-btn")?.addEventListener("click", addVoiceChannel);
  document.getElementById("voice-leave-btn")?.addEventListener("click",  leaveVoice);
}

function renderSidebar() {
  // Text channels
  const tList = document.getElementById("text-channel-list")!;
  if (tList) {
    tList.innerHTML = "";
    state.textChannels.forEach(ch => {
      const el = document.createElement("div");
      el.className = `ch-item ch-text ${ch === state.activeText ? "active" : ""}`;
      el.dataset.ch = ch;
      const isDefault = ["general", "random"].includes(ch);
      el.innerHTML = `
        <span class="ch-icon">#</span>
        <span class="ch-name">${escapeHtml(ch)}</span>
        <span class="ch-unread" id="unread-${ch}" style="display:none">●</span>
        ${isDefault ? "" : `<button class="ch-del" data-ch="${ch}" data-type="text">×</button>`}`;
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("ch-del")) return;
        showText(ch);
      });
      tList.appendChild(el);
    });
  }
  // Voice channels
  const vList = document.getElementById("voice-channel-list")!;
  if (vList) {
    vList.innerHTML = "";
    state.voiceChannels.forEach(ch => {
      const el = document.createElement("div");
      const isActive = ch === state.activeVoice;
      el.className = `ch-item ch-voice ${isActive ? "active" : ""}`;
      el.dataset.ch = ch;
      const isDefault = ["Main", "Gaming", "AFK"].includes(ch);
      el.innerHTML = `
        <span class="ch-icon">🔊</span>
        <span class="ch-name">${escapeHtml(ch)}</span>
        ${isActive ? `<span class="ch-live">live</span>` : ""}
        ${isDefault ? "" : `<button class="ch-del" data-ch="${ch}" data-type="voice">×</button>`}`;
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("ch-del")) return;
        toggleVoiceChannel(ch);
      });
      vList.appendChild(el);
    });
    // Also show peers in active voice channel
    if (state.activeVoice) {
      const activeEl = vList.querySelector(`[data-ch="${state.activeVoice}"]`);
      if (activeEl) {
        const peersDiv = document.createElement("div");
        peersDiv.className = "voice-peers";
        // Show yourself first
        const selfEl = document.createElement("div");
        selfEl.className = "voice-peer-item";
        selfEl.innerHTML = `<span class="dot connected"></span><span>${escapeHtml(state.myNickname || state.fingerprint.slice(0, 8))}</span>`;
        peersDiv.appendChild(selfEl);
        // Show voice peers only
        voicePeers.forEach(fp => {
          const pEl = document.createElement("div");
          pEl.className = "voice-peer-item";
          pEl.innerHTML = `<span class="dot connected"></span><span>${escapeHtml(displayName(fp))}</span>`;
          peersDiv.appendChild(pEl);
        });
        activeEl.after(peersDiv);
      }
    }
  }
  // Wire delete buttons
  document.querySelectorAll(".ch-del").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const ch   = (btn as HTMLElement).dataset.ch!;
      const type = (btn as HTMLElement).dataset.type!;
      if (!confirm(`Delete ${type} channel "${ch}"?`)) return;
      if (type === "text") {
        state.textChannels = state.textChannels.filter(c => c !== ch);
        try { localStorage.removeItem(msgKey(ch)); } catch {}
        if (state.activeText === ch) showText("general");
      } else {
        state.voiceChannels = state.voiceChannels.filter(c => c !== ch);
        if (state.activeVoice === ch) leaveVoice();
      }
      saveChannelConfig();
      renderSidebar();
    });
  });
}

function updateStatusBadge() {
  const dot   = document.getElementById("status-dot");
  const label = document.getElementById("identity-label");
  const sname = document.getElementById("server-name");
  if (dot)   dot.classList.toggle("connected", state.connected);
  if (label) label.textContent = state.connected
    ? (state.myNickname || state.fingerprint.slice(0, 12))
    : "Offline";
  if (sname) sname.textContent = state.connected && state.serverUrl
    ? new URL(state.serverUrl.replace("ws://","http://").replace("wss://","https://")).hostname
    : "Quipu";
}

function addTextChannel() {
  const name = prompt("Channel name:");
  if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
  if (!slug || state.textChannels.includes(slug)) { alert("Invalid or duplicate name."); return; }
  state.textChannels.push(slug);
  saveChannelConfig();
  renderSidebar();
  showText(slug);
}

function addVoiceChannel() {
  const name = prompt("Voice channel name:");
  if (!name || !name.trim()) return;
  const ch = name.trim().slice(0, 32);
  if (state.voiceChannels.includes(ch)) { alert("Channel already exists."); return; }
  state.voiceChannels.push(ch);
  saveChannelConfig();
  renderSidebar();
}

// ── Text view ─────────────────────────────────────────────────────────────────

function showText(ch: string) {
  state.activeText = ch;
  // Clear unread badge
  const badge = document.getElementById(`unread-${ch}`);
  if (badge) badge.style.display = "none";

  const content = document.getElementById("main-content")!;
  content.innerHTML = `
    <div class="text-view">
      <div class="text-header">
        <span class="text-header-icon">#</span>
        <span class="text-header-name">${escapeHtml(ch)}</span>
        <span class="text-header-status" id="text-status">
          ${state.connected ? `${state.peers.size} peer(s) connected` : "Not connected"}
        </span>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-form">
        <input class="chat-input" id="chat-input" type="text"
          placeholder="${state.connected ? `Message #${ch}` : "Connect to a server first…"}"
          autocomplete="off" maxlength="2000"
          ${state.connected ? "" : "disabled"} />
        <button class="chat-send" id="chat-send-btn" ${state.connected ? "" : "disabled"}>Send</button>
      </div>
    </div>`;

  // Load local messages
  const msgs = loadMsgs(ch);
  if (msgs.length === 0) {
    document.getElementById("chat-messages")!.innerHTML =
      `<p class="empty-hint">No messages yet in #${escapeHtml(ch)}.</p>`;
  } else {
    msgs.forEach(m => renderMsg({ ...m, ts: new Date(m.ts) }));
  }
  scrollBottom();
  setupChatInput(ch);
  renderSidebar(); // update active state
}

function setupChatInput(ch: string) {
  const input   = document.getElementById("chat-input")   as HTMLInputElement | null;
  const sendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement | null;
  if (!input || !sendBtn) return;
  const send = async () => {
    const text = input.value.trim();
    if (!text || !state.connected) return;
    input.value = "";
    const msg = { id: chatNextId++, from: "me", text, ts: new Date() };
    const container = document.getElementById("chat-messages")!;
    const hint = container.querySelector(".empty-hint");
    if (hint) hint.remove();
    saveMsg(ch, { ...msg, ts: msg.ts.toISOString() });
    renderMsg(msg);
    try {
      // All text channels share one signaling room. Channel routing is via prefix.
      await invoke("send_chat", {
        text: `__ch:${ch}:${text}`,
        fingerprint: state.fingerprint,
        room: "quipu-main",
      });
    } catch (e: any) {
      renderMsg({ id: chatNextId++, from: "system", text: `⚠ Not sent: ${e}`, ts: new Date() });
    }
  };
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  input.focus();
}

function renderMsg(msg: { id: number; from: string; text: string; ts: Date }) {
  const container = document.getElementById("chat-messages");
  if (!container) return;
  const isSys  = msg.from === "system";
  const isSelf = msg.from === "me";
  const time   = msg.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const label  = isSys ? "" : isSelf ? (state.myNickname || "you") : displayName(msg.from);
  const el     = document.createElement("div");
  el.className = `msg ${isSys ? "msg-system" : isSelf ? "msg-self" : "msg-peer"}`;
  el.innerHTML = isSys
    ? `<span class="msg-body">${escapeHtml(msg.text)}</span>`
    : `<span class="msg-meta">${escapeHtml(label)} · ${time}</span><span class="msg-body">${escapeHtml(msg.text)}</span>`;
  container.appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  const el = document.getElementById("chat-messages");
  if (el) el.scrollTop = el.scrollHeight;
}

// ── Settings view ─────────────────────────────────────────────────────────────

function showSettings() {
  const content = document.getElementById("main-content")!;
  content.innerHTML = `
    <div class="settings-view">
      <div class="settings-header">
        <h1>Settings</h1>
        <button class="btn-secondary" id="close-settings-btn">Back</button>
      </div>

      <section class="settings-section">
        <h2>Signaling server</h2>
        <label class="field"><span>Server URL</span>
          <input id="cfg-url" type="text" placeholder="ws://your.server:8181/ws"
            spellcheck="false" value="${escapeHtml(state.serverUrl)}" /></label>
        <div class="settings-actions">
          <button class="btn-primary"   id="cfg-connect-btn">Connect</button>
          <button class="btn-secondary" id="cfg-disconnect-btn">Disconnect</button>
        </div>
        <p class="settings-hint" id="cfg-status"></p>
      </section>

      <section class="settings-section">
        <h2>Identity</h2>
        <label class="field"><span>Nickname</span>
          <input id="cfg-nickname" type="text" placeholder="e.g. Beleg"
            maxlength="32" value="${escapeHtml(state.myNickname)}" /></label>
        <label class="field"><span>Fingerprint</span>
          <input id="cfg-fp" type="text" readonly value="${escapeHtml(state.fingerprint)}" /></label>
        <div class="settings-actions">
          <button class="btn-primary" id="cfg-save-identity-btn">Save nickname</button>
        </div>
        <p class="settings-hint">Share your fingerprint with friends so they can verify you.</p>
      </section>

      <section class="settings-section">
        <h2>Connected peers</h2>
        <div id="peer-nickname-list"></div>
      </section>

      <section class="settings-section">
        <h2>Updates</h2>
        <div class="settings-actions">
          <button class="btn-primary" id="update-check-btn">Check for updates</button>
        </div>
        <div id="update-status" class="update-status"></div>
      </section>
    </div>`;

  renderPeerNicknameList();
  prefillSettings();

  document.getElementById("close-settings-btn")?.addEventListener("click", () => showText(state.activeText));

  document.getElementById("cfg-connect-btn")?.addEventListener("click", async () => {
    const url = (document.getElementById("cfg-url") as HTMLInputElement).value.trim();
    const st  = document.getElementById("cfg-status")!;
    if (!url) { st.textContent = "Enter a server URL."; return; }
    state.serverUrl = url;
    st.textContent  = "Connecting…";
    try {
      await invoke("save_config", { serverUrl: url, room: "quipu-main", nickname: state.myNickname });
      await invoke("connect_signaling", { url, room: "quipu-main", fingerprint: state.fingerprint });
    } catch (e: any) { st.textContent = `Error: ${e}`; st.className = "settings-hint error"; }
  });

  document.getElementById("cfg-disconnect-btn")?.addEventListener("click", () => {
    setConnected(false);
    if (state.activeVoice) leaveVoice();
    state.peers.forEach(p => p.pc?.close());
    state.peers.clear();
  });

  document.getElementById("cfg-save-identity-btn")?.addEventListener("click", async () => {
    const nick = (document.getElementById("cfg-nickname") as HTMLInputElement).value.trim().slice(0, 32);
    state.myNickname = nick;
    await invoke("save_config", { serverUrl: state.serverUrl, room: "quipu-main", nickname: nick }).catch(() => {});
    updateStatusBadge();
    if (state.connected) broadcastNickname();
  });

  document.getElementById("update-check-btn")?.addEventListener("click", checkForUpdates);
}

function prefillSettings() {
  const url  = document.getElementById("cfg-url")      as HTMLInputElement | null;
  const nick = document.getElementById("cfg-nickname") as HTMLInputElement | null;
  const fp   = document.getElementById("cfg-fp")       as HTMLInputElement | null;
  if (url)  url.value  = state.serverUrl;
  if (nick) nick.value = state.myNickname;
  if (fp)   fp.value   = state.fingerprint;
}

function renderPeerNicknameList() {
  const list = document.getElementById("peer-nickname-list");
  if (!list) return;
  if (state.peers.size === 0) { list.innerHTML = `<p class="settings-hint">No peers connected.</p>`; return; }
  list.innerHTML = "";
  state.peers.forEach(peer => {
    const div = document.createElement("div");
    div.className = "peer-nick-row";
    div.innerHTML = `
      <span class="peer-nick-fp">${peer.fp.slice(0, 16)}</span>
      <input class="peer-nick-input" type="text" placeholder="Nickname…"
        value="${escapeHtml(state.nicknames.get(peer.fp) || "")}" maxlength="32" data-fp="${peer.fp}" />
      <button class="btn-secondary peer-nick-save" data-fp="${peer.fp}">Save</button>`;
    list.appendChild(div);
  });
  list.querySelectorAll(".peer-nick-save").forEach(btn => {
    btn.addEventListener("click", () => {
      const fp    = (btn as HTMLElement).dataset.fp!;
      const input = list.querySelector(`input[data-fp="${fp}"]`) as HTMLInputElement;
      if (input) { state.nicknames.set(fp, input.value.trim().slice(0, 32)); renderSidebar(); }
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
      <div class="settings-actions" style="margin-top:0.75rem">
        <button class="btn-primary" id="update-install-btn">Install</button>
      </div><p id="update-dl-status" class="settings-hint"></p>`);
    document.getElementById("update-install-btn")?.addEventListener("click", installUpdate);
  } catch (e: any) { setUpdateStatus(`⚠ ${e}`, "error"); btn.disabled = false; }
}

async function installUpdate() {
  const btn = document.getElementById("update-install-btn") as HTMLButtonElement;
  const st  = document.getElementById("update-dl-status")!;
  btn.disabled = true; st.textContent = "Starting…";
  const { listen: listenEv } = await import("@tauri-apps/api/event");
  const unlisten = await listenEv<{ downloaded?: number; total?: number | null; finished?: boolean }>(
    "update-progress", (ev) => {
      const d = ev.payload;
      if (d.finished) st.textContent = "Installing… restarting shortly.";
      else if (d.downloaded != null) {
        const pct = d.total ? Math.round((d.downloaded / d.total) * 100) : "…";
        st.textContent = `Downloading: ${(d.downloaded/1024/1024).toFixed(1)} MB (${pct}%)`;
      }
    });
  try { await invoke("install_update"); unlisten(); }
  catch (e: any) { unlisten(); st.textContent = `Failed: ${e}`; btn.disabled = false; }
}

// ── Signaling events ──────────────────────────────────────────────────────────

function setConnected(v: boolean) {
  state.connected = v;
  updateStatusBadge();
  // Refresh chat input enabled state if text view is showing
  const input   = document.getElementById("chat-input")   as HTMLInputElement | null;
  const sendBtn = document.getElementById("chat-send-btn") as HTMLButtonElement | null;
  if (input)   input.disabled   = !v;
  if (sendBtn) sendBtn.disabled = !v;
  const st = document.getElementById("text-status");
  if (st) st.textContent = v ? `${state.peers.size} peer(s) connected` : "Not connected";
}

async function onSignalingStatus(payload: { connected: boolean; fingerprint?: string; room?: string }) {
  setConnected(payload.connected);
  const cfgStatus = document.getElementById("cfg-status");
  if (payload.connected) {
    if (cfgStatus) { cfgStatus.textContent = "Connected"; cfgStatus.className = "settings-hint ok"; }
    broadcastNickname();
    // Do NOT call connect_signaling again here — that causes an infinite loop.
    // All text channels share the single "quipu-main" room connection.
    // Only voice channels get their own room, handled separately in toggleVoiceChannel.
  } else {
    if (cfgStatus) { cfgStatus.textContent = "Disconnected"; cfgStatus.className = "settings-hint"; }
    if (state.activeVoice) leaveVoice();
    state.peers.forEach(p => p.pc?.close());
    state.peers.clear();
    renderSidebar();
  }
}

async function onSignalingMessage(msg: any) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "join":      onPeerJoined(msg.from); break;
    case "leave":     onPeerLeft(msg.from);   break;
    case "chat":      onChatMessage(msg);      break;
    case "history":   onHistory(msg);          break;
    case "offer":     onRtcOffer(msg);        break;
    case "answer":    onRtcAnswer(msg);       break;
    case "candidate": onRtcCandidate(msg);    break;
  }
}

function onHistory(msg: any) {
  // msg.payload is an array of StoredMessage from the server
  const items: Array<{ from: string; payload: { text: string }; at: number }> = msg.payload ?? [];
  items.forEach(item => {
    const text = item.payload?.text ?? "";
    if (!text || text.startsWith("__nick:")) return;
    let ch   = "general";
    let body = text;
    if (text.startsWith("__ch:")) {
      const parts = text.slice(5).split(":");
      ch   = parts[0] || "general";
      body = parts.slice(1).join(":");
    }
    if (!body) return;
    const stored: StoredMessage = {
      id:   chatNextId++,
      from: item.from,
      text: body,
      ts:   new Date(item.at).toISOString(),
    };
    // Only store if not already in local storage (avoid duplicates)
    const existing = loadMsgs(ch);
    const alreadyHave = existing.some(m => m.from === stored.from && m.text === stored.text && Math.abs(new Date(m.ts).getTime() - item.at) < 5000);
    if (!alreadyHave) saveMsg(ch, stored);
  });
  // Refresh view if current channel was updated
  showText(state.activeText);
}

// ── Nicknames ─────────────────────────────────────────────────────────────────

function displayName(fp: string): string {
  return state.nicknames.get(fp) || fp.slice(0, 8);
}

function broadcastNickname() {
  if (!state.connected || !state.myNickname) return;
  invoke("send_chat", { text: `__nick:${state.myNickname}`, fingerprint: state.fingerprint, room: "quipu-main" }).catch(() => {});
}

// ── Peer lifecycle ────────────────────────────────────────────────────────────

function onPeerJoined(fp: string) {
  if (!fp || fp === state.fingerprint) return;
  if (!state.peers.has(fp)) state.peers.set(fp, { fp, pc: null as any, muted: false });
  // If we're in a voice channel, this join came from the voice room
  if (state.activeVoice) voicePeers.add(fp);
  renderSidebar();
  const st = document.getElementById("text-status");
  if (st) st.textContent = `${state.peers.size} peer(s) connected`;
  if (state.connected && state.myNickname) broadcastNickname();
  if (state.activeVoice) createOrGetPC(fp, true);
}

function onPeerLeft(fp: string) {
  const peer = state.peers.get(fp);
  if (peer) { peer.pc?.close(); state.peers.delete(fp); }
  voicePeers.delete(fp);
  document.getElementById(`audio-${fp}`)?.remove();
  renderSidebar();
  const st = document.getElementById("text-status");
  if (st) st.textContent = `${state.peers.size} peer(s) connected`;
  renderMsg({ id: chatNextId++, from: "system", text: `${displayName(fp)} left`, ts: new Date() });
}

function onChatMessage(msg: any) {
  const rawText = msg.payload?.text ?? "";
  if (!rawText) return;
  if (rawText.startsWith("__nick:")) {
    const nick = rawText.slice(7).trim();
    if (msg.from && nick) { state.nicknames.set(msg.from, nick.slice(0, 32)); renderSidebar(); }
    return;
  }
  let ch = "general", text = rawText;
  if (rawText.startsWith("__ch:")) {
    const parts = rawText.slice(5).split(":");
    ch   = parts[0] || "general";
    text = parts.slice(1).join(":");
  }
  if (!text) return;
  const chatMsg = { id: chatNextId++, from: msg.from ?? "?", text, ts: new Date() };
  saveMsg(ch, { ...chatMsg, ts: chatMsg.ts.toISOString() });
  if (ch === state.activeText) {
    const container = document.getElementById("chat-messages");
    const hint = container?.querySelector(".empty-hint");
    if (hint) hint.remove();
    renderMsg(chatMsg);
  } else {
    const badge = document.getElementById(`unread-${ch}`);
    if (badge) badge.style.display = "inline";
  }
}

// ── Voice channels ────────────────────────────────────────────────────────────

async function toggleVoiceChannel(ch: string) {  if (!state.connected) { alert("Connect to a server first (Settings)."); return; }
  if (state.activeVoice === ch) { leaveVoice(); return; }
  if (state.activeVoice) leaveVoice();
  // Join the voice channel
  const sel = document.getElementById("mic-select") as HTMLSelectElement | null;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: (sel?.value) ? { deviceId: { exact: sel.value } } : true,
      video: false,
    });
  } catch (e) { alert(`Microphone access denied: ${e}`); return; }
  state.activeVoice = ch;
  // Show voice status bar at bottom of sidebar
  const voiceStatus = document.getElementById("voice-status")!;
  const voiceLabel  = document.getElementById("voice-status-label")!;
  voiceStatus.style.display = "flex";
  voiceLabel.textContent    = `🔊 ${ch}`;
  // Announce our nickname to peers immediately
  broadcastNickname();
  // Initiate WebRTC connections to all known peers over the existing signaling connection
  state.peers.forEach((_, fp) => createOrGetPC(fp, true));
  renderSidebar();
}

function leaveVoice() {
  state.activeVoice = null;
  voicePeers.clear();
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  state.peers.forEach(p => { p.pc?.close(); state.peers.set(p.fp, { ...p, pc: null as any }); });
  document.getElementById("audio-container")?.remove();
  const voiceStatus = document.getElementById("voice-status");
  if (voiceStatus) voiceStatus.style.display = "none";
  renderSidebar();
}

// ── WebRTC ────────────────────────────────────────────────────────────────────

function createOrGetPC(remoteFp: string, isInitiator: boolean): RTCPeerConnection {
  const existing = state.peers.get(remoteFp);
  if (existing?.pc && existing.pc.connectionState !== "closed" && existing.pc.connectionState !== "failed") return existing.pc;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream?.getTracks().forEach(track => { localStream && pc.addTrack(track, localStream); });
  // Audio output — attach to a hidden container in body
  pc.ontrack = (ev) => {
    let container = document.getElementById("audio-container");
    if (!container) { container = document.createElement("div"); container.id = "audio-container"; document.body.appendChild(container); }
    let audio = document.getElementById(`audio-${remoteFp}`) as HTMLAudioElement | null;
    if (!audio) { audio = document.createElement("audio"); audio.id = `audio-${remoteFp}`; audio.autoplay = true; container.appendChild(audio); }
    audio.srcObject = ev.streams[0];
  };
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    invoke("send_signal", { kind: "candidate", to: remoteFp, payload: ev.candidate.toJSON(), fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
  };
  pc.onconnectionstatechange = () => renderSidebar();
  state.peers.set(remoteFp, { fp: remoteFp, pc, muted: false });
  if (isInitiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      invoke("send_signal", { kind: "offer", to: remoteFp, payload: offer, fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
    });
  }
  return pc;
}

async function onRtcOffer(msg: any) {
  if (!state.activeVoice || !localStream) return;
  const pc = createOrGetPC(msg.from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await invoke("send_signal", { kind: "answer", to: msg.from, payload: answer, fingerprint: state.fingerprint, room: "quipu-main" });
}

async function onRtcAnswer(msg: any) {
  const peer = state.peers.get(msg.from); if (!peer?.pc) return;
  await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
}

async function onRtcCandidate(msg: any) {
  const peer = state.peers.get(msg.from); if (!peer?.pc) return;
  try { await peer.pc.addIceCandidate(new RTCIceCandidate(msg.payload)); } catch {}
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

init();
