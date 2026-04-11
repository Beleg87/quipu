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
  activeVoice:   string | null;
  activeText:    string;
  textChannels:  string[];
  voiceChannels: string[];
  iceMode:       "direct" | "relay";
  turnUrl:       string;
  turnUser:      string;
  turnPass:      string;
  myRole:        "admin" | "mod" | "member";
  adminFp:       string;
  modFps:        Set<string>;
  bans:          Map<string, string>; // fp → reason
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
  iceMode:       "direct",
  turnUrl:       "",
  turnUser:      "",
  turnPass:      "",
  myRole:        "member",
  adminFp:       "",
  modFps:        new Set(),
  bans:          new Map(),
};

// Build ICE server list based on current mode
function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  if (state.iceMode === "relay" && state.turnUrl) {
    servers.push({
      urls:       state.turnUrl,
      username:   state.turnUser,
      credential: state.turnPass,
    });
    // Force relay-only so traffic always goes through TURN
    // (prevents direct connection attempts that could reveal IPs)
  }
  return servers;
}
let localStream: MediaStream | null = null;
let chatNextId = 1;

// Per-channel voice peer tracking — who is in which voice channel
// Key: channel name, Value: set of fingerprints
const channelPeers: Map<string, Set<string>> = new Map();

// voicePeers = peers in MY currently active channel (convenience alias)
const voicePeers: Set<string> = new Set();

// Output device ID (for speaker selection)
let outputDeviceId: string = "";

// Speaking indicator: fp → boolean
const speakingPeers: Map<string, boolean> = new Map();
let speakingAnalyser: AnalyserNode | null = null;
let speakingTimer: ReturnType<typeof setInterval> | null = null;

// Per-peer volume (0–200, where 100 = normal)
const peerVolumes: Map<string, number> = new Map();
// fp → audio element (covers both SFU and P2P modes)
const peerAudioEls: Map<string, HTMLAudioElement> = new Map();
// Queue of fps that recently sent __voice-join (for audio element association)
const pendingAudioFps: string[] = [];
// Pending screen-start metadata (broadcast may arrive before or after track)
const pendingScreenMeta: Map<string, string> = new Map(); // fp → label

function getPeerVolume(fp: string): number {
  return peerVolumes.get(fp) ?? 100;
}

function setPeerVolume(fp: string, vol: number) {
  peerVolumes.set(fp, vol);
  // Look up audio element by fp (works for both SFU and P2P modes)
  const audio = peerAudioEls.get(fp) ?? document.getElementById(`audio-${fp}`) as HTMLAudioElement | null;
  if (audio) audio.volume = Math.min(vol / 100, 1.0);
  applyVolumeBoost(fp, vol);
}

// AudioContext gain nodes for >100% volume boost per peer
const gainNodes: Map<string, { ctx: AudioContext; gain: GainNode }> = new Map();

function applyVolumeBoost(fp: string, vol: number) {
  const audio = peerAudioEls.get(fp) ?? document.getElementById(`audio-${fp}`) as HTMLAudioElement | null;
  if (!audio || !audio.srcObject) return;
  if (vol <= 100) {
    // Just use the audio element volume, no Web Audio needed
    audio.volume = vol / 100;
    gainNodes.delete(fp);
    return;
  }
  // vol > 100: use Web Audio API GainNode
  let node = gainNodes.get(fp);
  if (!node) {
    const ctx  = new AudioContext();
    const src  = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(ctx.destination);
    node = { ctx, gain };
    gainNodes.set(fp, node);
    audio.volume = 1.0; // let GainNode handle the boost
  }
  node.gain.gain.value = vol / 100;
}


// ── Sound system ──────────────────────────────────────────────────────────────
// All sounds generated via Web Audio API — no files needed

let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Unlock AudioContext on first user gesture (required by browsers)
function unlockAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  document.removeEventListener("click", unlockAudio);
  document.removeEventListener("keydown", unlockAudio);
}
document.addEventListener("click", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });

function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.15,
  fadeOut = true,
) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    if (fadeOut) gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {}
}

const sounds = {
  // Peer joined signaling (soft double-blip up)
  peerJoin: () => {
    playTone(660, 0.12, "sine", 0.12);
    setTimeout(() => playTone(880, 0.15, "sine", 0.12), 120);
  },
  // Peer left (soft double-blip down)
  peerLeave: () => {
    playTone(880, 0.12, "sine", 0.12);
    setTimeout(() => playTone(660, 0.15, "sine", 0.10), 120);
  },
  // Joined voice channel (warm chord)
  voiceJoin: () => {
    playTone(523, 0.25, "sine", 0.10); // C
    setTimeout(() => playTone(659, 0.25, "sine", 0.08), 60); // E
    setTimeout(() => playTone(784, 0.30, "sine", 0.07), 120); // G
  },
  // Left voice channel (reverse chord, quieter)
  voiceLeave: () => {
    playTone(784, 0.15, "sine", 0.08);
    setTimeout(() => playTone(523, 0.20, "sine", 0.07), 100);
  },
  // Screen share started (bright ascending)
  screenShare: () => {
    playTone(880, 0.12, "sine", 0.10);
    setTimeout(() => playTone(1100, 0.12, "sine", 0.09), 100);
    setTimeout(() => playTone(1320, 0.20, "sine", 0.08), 200);
  },
  // Remote control request (attention — two-tone alert)
  remoteRequest: () => {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        playTone(880, 0.08, "square", 0.08);
        setTimeout(() => playTone(1100, 0.08, "square", 0.07), 90);
      }, i * 220);
    }
  },
};

// ── AFK silence detection ─────────────────────────────────────────────────────

let afkTimer: ReturnType<typeof setTimeout> | null = null;
let afkAnalyser: AnalyserNode | null = null;
const AFK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function startAfkDetection() {
  stopAfkDetection();
  if (!localStream) return;
  try {
    const ctx      = new AudioContext();
    const src      = ctx.createMediaStreamSource(localStream);
    afkAnalyser    = ctx.createAnalyser();
    afkAnalyser.fftSize = 256;
    src.connect(afkAnalyser);
    checkSilence();
  } catch (e) { console.warn("AFK detection failed to init:", e); }
}

function checkSilence() {
  if (!afkAnalyser || !state.activeVoice) return;
  const data = new Uint8Array(afkAnalyser.frequencyBinCount);
  afkAnalyser.getByteFrequencyData(data);
  const max = Math.max(...data);
  if (max > 10) {
    // Sound detected — reset AFK timer, send activity heartbeat to server
    if (afkTimer) { clearTimeout(afkTimer); afkTimer = null; }
    invoke("send_activity", { fingerprint: state.fingerprint, room: "quipu-main" }).catch(() => {});
    afkTimer = setTimeout(() => {
      // silence for AFK_TIMEOUT_MS — server's own ticker will send the move command
    }, AFK_TIMEOUT_MS);
  }
  if (state.activeVoice) requestAnimationFrame(checkSilence);
}

function stopAfkDetection() {
  if (afkTimer) { clearTimeout(afkTimer); afkTimer = null; }
  afkAnalyser = null;
}

// ── Speaking indicator ───────────────────────────────────────────────────────

function startSpeakingDetection() {
  stopSpeakingDetection();
  if (!localStream) return;
  try {
    const ctx  = new AudioContext();
    const src  = ctx.createMediaStreamSource(localStream);
    speakingAnalyser = ctx.createAnalyser();
    speakingAnalyser.fftSize = 512;
    speakingAnalyser.smoothingTimeConstant = 0.3;
    src.connect(speakingAnalyser);
    const data = new Uint8Array(speakingAnalyser.frequencyBinCount);
    speakingTimer = setInterval(() => {
      if (!speakingAnalyser) return;
      speakingAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const isSpeaking = avg > 8;
      const wasSpeaking = speakingPeers.get(state.fingerprint);
      if (isSpeaking !== wasSpeaking) {
        speakingPeers.set(state.fingerprint, isSpeaking);
        renderSidebarSpeaking();
      }
    }, 150);
  } catch (e) { console.warn("Speaking detection init failed:", e); }
}

function stopSpeakingDetection() {
  if (speakingTimer) { clearInterval(speakingTimer); speakingTimer = null; }
  speakingAnalyser = null;
  speakingPeers.clear();
}

// Monitor a remote peer's audio element for speaking activity
const peerSpeakingTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

function monitorPeerAudio(fp: string, audio: HTMLAudioElement) {
  // Clean up any existing monitor for this peer
  const existing = peerSpeakingTimers.get(fp);
  if (existing) clearInterval(existing);
  try {
    const ctx  = new AudioContext();
    const src  = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.3;
    src.connect(analyser);
    src.connect(ctx.destination); // must reconnect to output after createMediaElementSource
    const data = new Uint8Array(analyser.frequencyBinCount);
    const timer = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const speaking = avg > 8;
      if (speakingPeers.get(fp) !== speaking) {
        speakingPeers.set(fp, speaking);
        // Update just this peer's dot
        const dot = document.querySelector(`.voice-peer-item[data-fp="${fp}"] .dot`) as HTMLElement | null;
        if (dot) dot.className = `dot ${speaking ? "speaking" : "connected"}`;
      }
    }, 150);
    peerSpeakingTimers.set(fp, timer);
  } catch (e) { console.warn("Peer audio monitor failed:", e); }
}

// Update just the speaking dots without full sidebar re-render
function renderSidebarSpeaking() {
  const isSpeaking = speakingPeers.get(state.fingerprint);
  const selfDot = document.querySelector(".voice-peer-item .dot.self-dot") as HTMLElement | null;
  if (selfDot) {
    selfDot.className = `dot ${isSpeaking ? "speaking" : "connected"} self-dot`;
  }
}

// ── Role helpers ──────────────────────────────────────────────────────────────

function roleBadge(fp: string): string {
  if (fp === state.adminFp)    return `<span class="role-badge admin" title="Admin">⚑</span>`;
  if (state.modFps.has(fp))   return `<span class="role-badge mod" title="Mod">★</span>`;
  return "";
}

function isPrivileged(): boolean {
  return state.myRole === "admin" || state.myRole === "mod";
}

// ── Moderation actions ────────────────────────────────────────────────────────

async function sendKick(targetFp: string) {
  if (!confirm(`Kick ${displayName(targetFp)}?`)) return;
  await invoke("send_moderation", { action: "kick", payload: { target: targetFp }, fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
}

async function sendBan(targetFp: string) {
  const reason = prompt(`Ban reason for ${displayName(targetFp)}:`);
  if (reason === null) return;
  await invoke("send_moderation", { action: "ban", payload: { target: targetFp, reason: reason || "banned" }, fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
}

async function sendUnban(targetFp: string) {
  if (!confirm(`Unban ${targetFp.slice(0, 12)}…?`)) return;
  await invoke("send_moderation", { action: "unban", payload: { target: targetFp }, fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
}

async function sendPromote(targetFp: string, role: "mod" | "member") {
  await invoke("send_moderation", { action: "promote", payload: { target: targetFp, role }, fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
}

async function sendMove(targetFp: string, channel: string) {
  await invoke("send_moderation", { action: "move", payload: { target: targetFp, channel }, fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
}

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

function cleanLocalStorageInternals() {
  // Remove any internally-stored __voice-join/__voice-leave messages
  // that were cached before server-side filtering was added
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith("quipu_msgs_")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const msgs = JSON.parse(raw) as any[];
      const cleaned = msgs.filter(m => !isInternalMessage(m.text ?? ""));
      if (cleaned.length !== msgs.length) {
        localStorage.setItem(key, JSON.stringify(cleaned));
      }
    }
  } catch {}
}

async function init() {
  cleanLocalStorageInternals();
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
    const cfg = await invoke<{ server_url: string; room: string; nickname: string; ice_mode: string; turn_url: string; turn_user: string; turn_pass: string }>("load_config");
    state.serverUrl  = cfg.server_url;
    state.myNickname = cfg.nickname || "";
    state.iceMode    = (cfg.ice_mode === "relay") ? "relay" : "direct";
    state.turnUrl    = cfg.turn_url  || "";
    state.turnUser   = cfg.turn_user || "";
    state.turnPass   = cfg.turn_pass || "";
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
            <button class="btn-share" id="screen-share-btn" title="Share screen">⬡</button>
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
  document.getElementById("screen-share-btn")?.addEventListener("click", showSharePicker);
}

function renderSidebar() {
  // Show/hide channel management buttons based on role
  const addTextBtn  = document.getElementById("add-text-ch-btn");
  const addVoiceBtn = document.getElementById("add-voice-ch-btn");
  const canManage   = isPrivileged();
  if (addTextBtn)  addTextBtn.style.display  = canManage ? "" : "none";
  if (addVoiceBtn) addVoiceBtn.style.display = canManage ? "" : "none";

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
        ${isDefault || !canManage ? "" : `<button class="ch-del" data-ch="${ch}" data-type="text">×</button>`}`;
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
      // Show who is in this channel (from channelPeers map)
      const chPeers = channelPeers.get(ch) ?? new Set<string>();
      const peerNames = [...chPeers].map(fp => displayName(fp)).join(", ");
      const peerBadge = chPeers.size > 0 ? `<span class="ch-peer-count" title="${peerNames}">${chPeers.size}</span>` : "";
      el.innerHTML = `
        <span class="ch-icon">🔊</span>
        <span class="ch-name">${escapeHtml(ch)}</span>
        ${peerBadge}
        ${isActive ? `<span class="ch-live">live</span>` : ""}
        ${isDefault || !canManage ? "" : `<button class="ch-del" data-ch="${ch}" data-type="voice">×</button>`}`;
      el.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("ch-del")) return;
        toggleVoiceChannel(ch);
      });
      // Drop target: admin/mod can drag peers onto channels to move them
      if (isPrivileged()) {
        el.addEventListener("dragover", (e) => {
          e.preventDefault();
          el.classList.add("drag-over");
        });
        el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
        el.addEventListener("drop", (e) => {
          e.preventDefault();
          el.classList.remove("drag-over");
          const fp = (e as DragEvent).dataTransfer?.getData("text/plain");
          if (fp && fp !== state.fingerprint) sendMove(fp, ch);
        });
      }
      vList.appendChild(el);
    });
    // Also show peers in active voice channel
    if (state.activeVoice) {
      // Keep voicePeers in sync with channelPeers — source of truth
      const chSet = channelPeers.get(state.activeVoice) ?? new Set<string>();
      chSet.forEach(fp => { if (fp !== state.fingerprint) voicePeers.add(fp); });
      // Remove peers from voicePeers who left the channel
      voicePeers.forEach(fp => { if (!chSet.has(fp)) voicePeers.delete(fp); });

      const activeEl = vList.querySelector(`[data-ch="${state.activeVoice}"]`);
      if (activeEl) {
        const peersDiv = document.createElement("div");
        peersDiv.className = "voice-peers";
        // Show yourself first
        const selfEl = document.createElement("div");
        selfEl.className = "voice-peer-item";
        const selfSpeaking = speakingPeers.get(state.fingerprint);
        selfEl.innerHTML = `
          <span class="dot ${selfSpeaking ? "speaking" : "connected"} self-dot"></span>
          <span class="voice-peer-name">${roleBadge(state.fingerprint)}${escapeHtml(state.myNickname || state.fingerprint.slice(0, 8))}</span>
          <span class="voice-peer-you">(you)</span>`;
        peersDiv.appendChild(selfEl);
        // Show each voice peer with volume slider and drag handle
        voicePeers.forEach(fp => {
          const vol = getPeerVolume(fp);
          const pEl = document.createElement("div");
          pEl.className = "voice-peer-item";
          pEl.dataset.fp = fp; // needed for speaking indicator targeting
          // Draggable for admin/mod to move peers between channels
          const draggable = isPrivileged() ? `draggable="true" data-fp="${fp}"` : "";
          pEl.innerHTML = `
            ${isPrivileged() ? `<span class="drag-handle" title="Drag to move">⠿</span>` : ""}
            <span class="dot connected"></span>
            <span class="voice-peer-name">${roleBadge(fp)}${escapeHtml(displayName(fp))}</span>
            <input class="peer-volume" type="range" min="0" max="200" value="${vol}"
              data-fp="${fp}" title="Volume: ${vol}%" />`;
          if (isPrivileged()) {
            pEl.setAttribute("draggable", "true");
            pEl.dataset.fp = fp;
            pEl.addEventListener("dragstart", (e) => {
              (e as DragEvent).dataTransfer?.setData("text/plain", fp);
              pEl.classList.add("dragging");
            });
            pEl.addEventListener("dragend", () => pEl.classList.remove("dragging"));
          }
          peersDiv.appendChild(pEl);
        });
        activeEl.after(peersDiv);
        // Wire volume sliders — use "input" for live feedback but skip re-render
        peersDiv.querySelectorAll(".peer-volume").forEach(slider => {
          const s = slider as HTMLInputElement;
          // Show live value without triggering full sidebar re-render
          s.addEventListener("input", () => {
            const val = parseInt(s.value);
            s.setAttribute("title", `Volume: ${val}%`);
            // Update visual label if present
            const label = s.nextElementSibling as HTMLElement | null;
            if (label?.classList.contains("vol-label")) label.textContent = `${val}%`;
          });
          // Apply volume only on release to avoid thrashing
          s.addEventListener("change", () => {
            const fp  = s.dataset.fp!;
            const val = parseInt(s.value);
            setPeerVolume(fp, val);
          });
        });
      }
    }
  }
  // Wire delete buttons
  // Screen share bar — shows above voice channels when sharing is active
  updateScreenBar();

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

function showText(ch: string, force = false) {
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

// Saved device selections — persist across settings re-opens
let savedMicId: string = localStorage.getItem("quipu_mic_id") || "";
let savedSpeakerId: string = localStorage.getItem("quipu_speaker_id") || "";

async function populateAudioDevices() {
  const micSel     = document.getElementById("mic-select")     as HTMLSelectElement | null;
  const speakerSel = document.getElementById("speaker-select") as HTMLSelectElement | null;
  if (!micSel && !speakerSel) return;

  try {
    // Without getUserMedia permission, device labels are empty strings
    // Try a quick silent request to unlock labels — ignore failure (user may deny)
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    tempStream?.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs  = devices.filter(d => d.kind === "audioinput");
    const outputs = devices.filter(d => d.kind === "audiooutput");

    if (micSel) {
      const prev = micSel.value || savedMicId;
      micSel.innerHTML = `<option value="">Default microphone</option>`;
      inputs.forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.text  = d.label || `Microphone ${d.deviceId.slice(0, 8)}`;
        if (d.deviceId === prev) opt.selected = true;
        micSel.appendChild(opt);
      });
      micSel.addEventListener("change", () => {
        savedMicId = micSel.value;
        localStorage.setItem("quipu_mic_id", savedMicId);
      });
    }

    if (speakerSel) {
      const prev = speakerSel.value || savedSpeakerId;
      speakerSel.innerHTML = `<option value="">Default speaker</option>`;
      outputs.forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.text  = d.label || `Speaker ${d.deviceId.slice(0, 8)}`;
        if (d.deviceId === prev) opt.selected = true;
        speakerSel.appendChild(opt);
      });
      speakerSel.addEventListener("change", () => {
        savedSpeakerId = speakerSel.value;
        outputDeviceId = savedSpeakerId;
        localStorage.setItem("quipu_speaker_id", savedSpeakerId);
        applyOutputDevice();
      });
    }
  } catch (e) { console.warn("Device enumeration failed:", e); }
}

function applyOutputDevice() {
  // Apply output device to all active audio elements
  document.querySelectorAll("audio").forEach(audio => {
    if (typeof (audio as any).setSinkId === "function" && outputDeviceId) {
      (audio as any).setSinkId(outputDeviceId).catch(console.warn);
    }
  });
}

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
        <h2>Audio devices</h2>
        <div class="field-group">
          <label class="field"><span>Microphone (input)</span>
            <select id="mic-select" class="cfg-select">
              <option value="">Default</option>
            </select>
          </label>
          <label class="field"><span>Speaker (output)</span>
            <select id="speaker-select" class="cfg-select">
              <option value="">Default</option>
            </select>
          </label>
        </div>
        <p class="settings-hint">Changes take effect on next voice join.</p>

        <h2>Connected peers</h2>
        <div id="peer-nickname-list"></div>
      </section>

      <section class="settings-section" id="ban-list-section" style="${state.myRole !== 'member' ? '' : 'display:none'}">
        <h2>Ban list</h2>
        <div id="ban-list"></div>
      </section>

      <section class="settings-section">
        <h2>Connection mode</h2>
        <div class="ice-mode-toggle">
          <label class="ice-option">
            <input type="radio" name="ice-mode" value="direct" id="ice-direct" />
            <div class="ice-option-body">
              <span class="ice-option-title">Direct (P2P)</span>
              <span class="ice-option-desc">STUN only. Lowest latency. May fail behind strict NAT / CGNAT.</span>
            </div>
          </label>
          <label class="ice-option">
            <input type="radio" name="ice-mode" value="relay" id="ice-relay" />
            <div class="ice-option-body">
              <span class="ice-option-title">Relay (TURN)</span>
              <span class="ice-option-desc">Routes voice through your TURN server. Fixes CGNAT. Slightly higher latency.</span>
            </div>
          </label>
        </div>
        <div id="turn-config" style="display:none">
          <label class="field" style="margin-top:0.75rem"><span>TURN server URL</span>
            <input id="cfg-turn-url" type="text" placeholder="turn:your.server:3478" spellcheck="false"
              value="${escapeHtml(state.turnUrl)}" /></label>
          <label class="field"><span>Username</span>
            <input id="cfg-turn-user" type="text" placeholder="quipu"
              value="${escapeHtml(state.turnUser)}" /></label>
          <label class="field"><span>Credential</span>
            <input id="cfg-turn-pass" type="password" placeholder="••••••••"
              value="${escapeHtml(state.turnPass)}" /></label>
        </div>
        <div class="settings-actions">
          <button class="btn-primary" id="cfg-save-ice-btn">Save connection mode</button>
        </div>
        <p class="settings-hint" id="ice-status"></p>
        <p class="settings-hint" style="margin-top:0.4rem">
          Need a TURN server? Run <code>coturn</code> on your gaming server —
          see <a href="#" id="coturn-help-link">setup guide</a> below.
        </p>
      </section>

      <section class="settings-section" id="coturn-guide" style="display:none">
        <h2>coturn quick setup</h2>
        <pre class="code-block"># On your gaming server (Linux):
apt install coturn

# /etc/turnserver.conf — minimal config:
listening-port=3478
fingerprint
lt-cred-mech
user=quipu:YOUR_PASSWORD
realm=quipu
total-quota=100
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

systemctl enable coturn
systemctl start coturn</pre>
        <p class="settings-hint" style="margin-top:0.5rem">
          Then set TURN URL to <code>turn:YOUR_SERVER_IP:3478</code>,
          username <code>quipu</code>, credential your password.
        </p>
      </section>
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

  // ── ICE / connection mode ──
  // Set initial radio state
  const directRadio = document.getElementById("ice-direct") as HTMLInputElement | null;
  const relayRadio  = document.getElementById("ice-relay")  as HTMLInputElement | null;
  const turnConfig  = document.getElementById("turn-config");
  if (directRadio && relayRadio && turnConfig) {
    directRadio.checked = state.iceMode === "direct";
    relayRadio.checked  = state.iceMode === "relay";
    turnConfig.style.display = state.iceMode === "relay" ? "block" : "none";
    // Show/hide TURN fields when mode changes
    [directRadio, relayRadio].forEach(r => {
      r.addEventListener("change", () => {
        turnConfig.style.display = relayRadio.checked ? "block" : "none";
      });
    });
  }
  document.getElementById("cfg-save-ice-btn")?.addEventListener("click", async () => {
    const relay    = (document.getElementById("ice-relay") as HTMLInputElement)?.checked;
    const turnUrl  = (document.getElementById("cfg-turn-url")  as HTMLInputElement)?.value.trim() || "";
    const turnUser = (document.getElementById("cfg-turn-user") as HTMLInputElement)?.value.trim() || "";
    const turnPass = (document.getElementById("cfg-turn-pass") as HTMLInputElement)?.value.trim() || "";
    const iceStatus = document.getElementById("ice-status")!;
    if (relay && !turnUrl) { iceStatus.textContent = "Enter a TURN server URL to use relay mode."; return; }
    state.iceMode  = relay ? "relay" : "direct";
    state.turnUrl  = turnUrl;
    state.turnUser = turnUser;
    state.turnPass = turnPass;
    try {
      await invoke("save_config", {
        serverUrl: state.serverUrl, room: "quipu-main", nickname: state.myNickname,
        iceMode: state.iceMode, turnUrl, turnUser, turnPass,
      });
      iceStatus.textContent = `Saved. Using ${state.iceMode === "relay" ? "TURN relay" : "direct P2P"} mode.`;
      iceStatus.className = "settings-hint ok";
    } catch (e: any) { iceStatus.textContent = `Save failed: ${e}`; }
  });
  // coturn guide toggle
  document.getElementById("coturn-help-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    const guide = document.getElementById("coturn-guide");
    if (guide) guide.style.display = guide.style.display === "none" ? "block" : "none";
  });
}

function prefillSettings() {
  const url      = document.getElementById("cfg-url")       as HTMLInputElement | null;
  const nick     = document.getElementById("cfg-nickname")  as HTMLInputElement | null;
  const fp       = document.getElementById("cfg-fp")        as HTMLInputElement | null;
  const turnUrl  = document.getElementById("cfg-turn-url")  as HTMLInputElement | null;
  const turnUser = document.getElementById("cfg-turn-user") as HTMLInputElement | null;
  const turnPass = document.getElementById("cfg-turn-pass") as HTMLInputElement | null;
  const turnCfg  = document.getElementById("turn-config");
  const direct   = document.getElementById("ice-direct")    as HTMLInputElement | null;
  const relay    = document.getElementById("ice-relay")     as HTMLInputElement | null;
  if (url) {
    url.value = state.serverUrl;
    // If blank, try loading from saved config again
    if (!state.serverUrl) {
      invoke<{ server_url: string }>("load_config").then(cfg => {
        if (cfg.server_url) { state.serverUrl = cfg.server_url; url.value = cfg.server_url; }
      }).catch(() => {});
    }
  }
  if (nick)     nick.value     = state.myNickname;
  if (fp)       fp.value       = state.fingerprint;
  if (turnUrl)  turnUrl.value  = state.turnUrl;
  if (turnUser) turnUser.value = state.turnUser;
  if (turnPass) turnPass.value = state.turnPass;
  if (direct)   direct.checked = state.iceMode === "direct";
  if (relay)    relay.checked  = state.iceMode === "relay";
  if (turnCfg)  turnCfg.style.display = state.iceMode === "relay" ? "block" : "none";
}

function renderPeerNicknameList() {
  const list = document.getElementById("peer-nickname-list");
  if (!list) return;
  if (state.peers.size === 0) { list.innerHTML = `<p class="settings-hint">No peers connected.</p>`; return; }
  list.innerHTML = "";
  state.peers.forEach(peer => {
    const fp   = peer.fp;
    const isMod  = state.modFps.has(fp);
    const isAdmin = fp === state.adminFp;
    const div = document.createElement("div");
    div.className = "peer-nick-row";
    div.innerHTML = `
      <span class="peer-nick-fp">${roleBadge(fp)}${fp.slice(0, 12)}</span>
      <input class="peer-nick-input" type="text" placeholder="Nickname…"
        value="${escapeHtml(state.nicknames.get(fp) || "")}" maxlength="32" data-fp="${fp}" />
      <button class="btn-secondary peer-nick-save" data-fp="${fp}">Save</button>
      ${isPrivileged() && !isAdmin ? `
        <button class="btn-secondary mod-kick" data-fp="${fp}" title="Kick">⊗</button>
        <button class="btn-danger mod-ban" data-fp="${fp}" title="Ban">⊘</button>
      ` : ""}
      ${state.myRole === "admin" && !isAdmin ? `
        <button class="btn-secondary mod-promote" data-fp="${fp}"
          data-role="${isMod ? "member" : "mod"}"
          title="${isMod ? "Remove mod" : "Make mod"}">
          ${isMod ? "★−" : "★+"}
        </button>
      ` : ""}`;
    list.appendChild(div);
  });
  // Wire save nickname
  list.querySelectorAll(".peer-nick-save").forEach(btn => {
    btn.addEventListener("click", () => {
      const fp    = (btn as HTMLElement).dataset.fp!;
      const input = list.querySelector(`input[data-fp="${fp}"]`) as HTMLInputElement;
      if (input) { state.nicknames.set(fp, input.value.trim().slice(0, 32)); renderSidebar(); }
    });
  });
  // Wire moderation buttons
  list.querySelectorAll(".mod-kick").forEach(btn => {
    btn.addEventListener("click", () => sendKick((btn as HTMLElement).dataset.fp!));
  });
  list.querySelectorAll(".mod-ban").forEach(btn => {
    btn.addEventListener("click", () => sendBan((btn as HTMLElement).dataset.fp!));
  });
  list.querySelectorAll(".mod-promote").forEach(btn => {
    btn.addEventListener("click", () => {
      const fp   = (btn as HTMLElement).dataset.fp!;
      const role = (btn as HTMLElement).dataset.role as "mod" | "member";
      sendPromote(fp, role);
    });
  });
}

function renderBanList() {
  const list = document.getElementById("ban-list");
  if (!list) return;
  if (state.bans.size === 0) { list.innerHTML = `<p class="settings-hint">No active bans.</p>`; return; }
  list.innerHTML = "";
  state.bans.forEach((reason, fp) => {
    const div = document.createElement("div");
    div.className = "peer-nick-row";
    div.innerHTML = `
      <span class="peer-nick-fp">${fp.slice(0, 16)}</span>
      <span class="ban-reason">${escapeHtml(reason)}</span>
      <button class="btn-secondary mod-unban" data-fp="${fp}">Unban</button>`;
    list.appendChild(div);
  });
  list.querySelectorAll(".mod-unban").forEach(btn => {
    btn.addEventListener("click", () => sendUnban((btn as HTMLElement).dataset.fp!));
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
    // Optimistically assume admin until the server sends a role message.
    // The server will correct this with a "role" message after join.
    // This ensures controls are visible even with the old server.
    if (state.myRole === "member" && state.peers.size === 0) {
      state.myRole  = "admin";
      state.adminFp = state.fingerprint;
      renderSidebar();
    }
    broadcastNickname();
  } else {
    if (cfgStatus) { cfgStatus.textContent = "Disconnected"; cfgStatus.className = "settings-hint"; }
    // Reset role on disconnect
    state.myRole  = "member";
    state.adminFp = "";
    state.modFps.clear();
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
    case "role":      onRole(msg);             break;
    case "command":   onCommand(msg);          break;
    case "offer":     onRtcOffer(msg);        break;
    case "answer":    onRtcAnswer(msg);       break;
    case "candidate":  onRtcCandidate(msg);     break;
    // SFU messages come back from server as JSON objects in the WS stream
    case "sfu-offer":
    case "sfu-ice":       handleSFUMessage(msg);        break;
    case "sfu-screen-start": onRemoteScreenStart(msg);  break;
    case "sfu-screen-stop":  onRemoteScreenStop(msg);   break;
  }
}

function onHistory(msg: any) {
  // msg.payload is an array of StoredMessage from the server
  const items: Array<{ from: string; payload: { text: string }; at: number }> = msg.payload ?? [];
  items.forEach(item => {
    const text = item.payload?.text ?? "";
    if (!text || isInternalMessage(text)) return;
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

function onRole(msg: any) {
  const p = msg.payload ?? {};
  state.myRole  = p.role   ?? "member";
  state.adminFp = p.admin  ?? "";
  state.modFps  = new Set(p.mods ?? []);
  state.bans.clear();
  if (p.bans) Object.entries(p.bans).forEach(([fp, reason]) => state.bans.set(fp, reason as string));
  // Show/hide ban list section
  const banSection = document.getElementById("ban-list-section");
  if (banSection) banSection.style.display = state.myRole !== "member" ? "" : "none";
  renderSidebar();
  renderPeerNicknameList();
  renderBanList();
  populateAudioDevices();
}

function onCommand(msg: any) {
  const p = msg.payload ?? {};
  switch (p.action) {
    case "kicked":
      showOverlay("⚠ You were kicked", `Kicked by ${displayName(p.by ?? "")}.`, false);
      setConnected(false);
      if (state.activeVoice) leaveVoice();
      state.peers.forEach(peer => peer.pc?.close());
      state.peers.clear();
      break;
    case "banned":
      showOverlay("🚫 You are banned", `Reason: ${p.reason ?? "no reason given"}`, true);
      setConnected(false);
      if (state.activeVoice) leaveVoice();
      state.peers.forEach(peer => peer.pc?.close());
      state.peers.clear();
      break;
    case "move":
      if (p.channel && state.voiceChannels.includes(p.channel)) {
        toggleVoiceChannel(p.channel);
      }
      break;
  }
}

function showOverlay(title: string, body: string, permanent: boolean) {
  const existing = document.getElementById("mod-overlay");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.id = "mod-overlay";
  overlay.className = "mod-overlay";
  overlay.innerHTML = `
    <div class="mod-overlay-box">
      <h2>${title}</h2>
      <p>${escapeHtml(body)}</p>
      ${permanent ? "" : `<button class="btn-primary" id="overlay-dismiss">Dismiss</button>`}
    </div>`;
  document.body.appendChild(overlay);
  if (!permanent) {
    document.getElementById("overlay-dismiss")?.addEventListener("click", () => overlay.remove());
  }
}

function onPeerJoined(fp: string) {
  if (!fp || fp === state.fingerprint) return;
  if (!state.peers.has(fp)) {
    state.peers.set(fp, { fp, pc: null as any, muted: false });
    sounds.peerJoin(); // new peer connected to signaling
  }
  // Do NOT add to voicePeers here — voice membership is tracked via __voice-join broadcasts only
  renderSidebar();
  broadcastNickname(); // make sure new peer gets our nickname
  // Tell everyone (including new peer) our current voice channel
  // This is a broadcast so all peers get updated sidebar state
  if (state.activeVoice && state.connected) {
    invoke("send_chat", {
      text: `__voice-join:${state.activeVoice}`,
      fingerprint: state.fingerprint,
      room: "quipu-main",
    }).catch(() => {});
  }
  const st = document.getElementById("text-status");
  if (st) st.textContent = `${state.peers.size} peer(s) connected`;
  if (state.connected && state.myNickname) broadcastNickname();
  if (state.activeVoice) createOrGetPC(fp, false); // tiebreaker decides who initiates
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
  const msgText = msg.payload?.text ?? "";
  // Screen share broadcasts
  if (msgText.startsWith("__screen-start:")) {
    const label = msgText.replace("__screen-start:", "");
    onRemoteScreenStart({ from: msg.from, payload: { label } });
    return;
  }
  if (msgText === "__screen-stop") {
    onRemoteScreenStop({ from: msg.from });
    return;
  }
  // Voice join broadcast — track which channel a peer is in
  if (msg.payload?.text?.startsWith("__voice-join:")) {
    const ch = msg.payload.text.replace("__voice-join:", "");
    channelPeers.forEach(set => set.delete(msg.from));
    if (!channelPeers.has(ch)) channelPeers.set(ch, new Set());
    channelPeers.get(ch)!.add(msg.from);
    if (ch === state.activeVoice) {
      voicePeers.add(msg.from);
      if (voiceMode === "p2p") createOrGetPC(msg.from, false);
      // Queue this fp for audio element association when their SFU track arrives
      if (!pendingAudioFps.includes(msg.from)) pendingAudioFps.push(msg.from);
    }
    renderSidebar();
    return;
  }
  // Voice leave broadcast — remove peer from voice without them disconnecting from signaling
  if (msg.payload?.text?.startsWith("__voice-leave:")) {
    const ch = msg.payload.text.replace("__voice-leave:", "");
    voicePeers.delete(msg.from);
    // Remove from all channel sets (not just the one named in the message)
    channelPeers.forEach(set => set.delete(msg.from));
    // Close their P2P connection if in P2P mode
    const peer = state.peers.get(msg.from);
    if (peer?.pc) { peer.pc.close(); state.peers.set(msg.from, { ...peer, pc: null as any }); }
    // Remove their audio element
    document.getElementById(`audio-${msg.from}`)?.remove();
    renderSidebar();
    return;
  }
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


// ── Voice connection ──────────────────────────────────────────────────────────

let voiceMode: "sfu" | "p2p" = "sfu";
let sfuPc: RTCPeerConnection | null = null;

// ── Screen share state ────────────────────────────────────────────────────────
let screenStream:  MediaStream | null = null;
let screenSender:  RTCRtpSender | null = null;
let focusedScreen: string | null = null; // fp of focused screen, null = grid

// Quality presets: [label, width, height, fps]
const QUALITY_PRESETS: [string, number, number, number][] = [
  ["Auto",      0,    0,    0  ],
  ["480p 30",   854,  480,  30 ],
  ["720p 30",   1280, 720,  30 ],
  ["720p 60",   1280, 720,  60 ],
  ["1080p 30",  1920, 1080, 30 ],
  ["1080p 60",  1920, 1080, 60 ],
  ["1080p 120", 1920, 1080, 120],
  ["1440p 60",  2560, 1440, 60 ],
  ["1440p 120", 2560, 1440, 120],
];

// Active screen shares: fp → { stream, label }
const activeScreens: Map<string, { stream: MediaStream; label: string }> = new Map();

async function toggleVoiceChannel(ch: string) {
  // Auto-connect to signaling if needed
  if (!state.connected) {
    if (!state.serverUrl) { alert("Set a server URL in Settings first."); return; }
    try {
      await invoke("connect_signaling", { url: state.serverUrl, room: "quipu-main", fingerprint: state.fingerprint });
      await new Promise(r => setTimeout(r, 600));
    } catch (e: any) { alert(`Could not connect: ${e}`); return; }
  }
  if (state.activeVoice === ch) { leaveVoice(); return; }
  if (state.activeVoice) leaveVoice();

  const micSel = document.getElementById("mic-select") as HTMLSelectElement | null;
  try {
    const audioConstraints: MediaTrackConstraints = {
      // Browser-native noise suppression — free, zero CPU cost
      noiseSuppression:   true,
      echoCancellation:   true,
      autoGainControl:    true,
    };
    const micId = micSel?.value || savedMicId;
    if (micId) audioConstraints.deviceId = { ideal: micId }; // ideal not exact — falls back gracefully
    localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
  } catch (e) { alert(`Microphone access denied: ${e}`); return; }

  state.activeVoice = ch;
  voicePeers.clear();
  // Seed voicePeers from channelPeers (who we know is already in this channel)
  // NOT from state.peers (which includes everyone connected to signaling, not just voice)
  const existingInChannel = channelPeers.get(ch) ?? new Set<string>();
  existingInChannel.forEach(fp => { if (fp !== state.fingerprint) voicePeers.add(fp); });
  // Track ourselves in this channel
  if (!channelPeers.has(ch)) channelPeers.set(ch, new Set());
  channelPeers.get(ch)!.add(state.fingerprint);
  startAfkDetection();
  startSpeakingDetection();

  const voiceStatus = document.getElementById("voice-status")!;
  const voiceLabel  = document.getElementById("voice-status-label")!;
  voiceStatus.style.display = "flex";

  // Try SFU first — 5 second timeout, then fall back to P2P
  const sfuOk = await trySFU(ch);
  if (sfuOk) {
    voiceMode = "sfu";
    voiceLabel.textContent = `\uD83D\uDD0A ${ch} \u00B7 SFU`;
    sounds.voiceJoin();
    broadcastNickname();
    invoke("send_chat", {
      text: `__voice-join:${ch}`,
      fingerprint: state.fingerprint,
      room: "quipu-main",
    }).catch(() => {});
    renderSidebar();
    renderScreenGrid();
    // Scan for any video tracks delivered in the initial join offer (e.g. active screen share)
    setTimeout(() => checkForNewVideoTracks(), 800);
    return;
  }

  // SFU failed — fall back to P2P mesh
  voiceMode = "p2p";
  voiceLabel.textContent = `\uD83D\uDD0A ${ch} \u00B7 P2P`;
  broadcastNickname();
  state.peers.forEach((_, fp) => createOrGetPC(fp, false));
  renderSidebar();
}

function trySFU(channel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false); }, 5000);

    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    sfuPc = pc;

    localStream?.getTracks().forEach(track => { localStream && pc.addTrack(track, localStream); });

    pc.ontrack = (ev) => {
      const track = ev.track;
      // Use the provided stream, or wrap track in a new MediaStream (renegotiation case)
      const stream = ev.streams[0] ?? new MediaStream([track]);
      if (track.kind === "audio") {
        let container = document.getElementById("audio-container");
        if (!container) { container = document.createElement("div"); container.id = "audio-container"; document.body.appendChild(container); }
        const sid = stream.id;
        let audio = document.getElementById(`audio-sfu-${sid}`) as HTMLAudioElement | null;
        if (!audio) { audio = document.createElement("audio"); audio.id = `audio-sfu-${sid}`; audio.autoplay = true; container.appendChild(audio); }
        audio.srcObject = stream;
        // Associate this audio element with the next pending fp so volume control works
        const pendingFp = pendingAudioFps.shift();
        if (pendingFp) {
          peerAudioEls.set(pendingFp, audio);
          audio.volume = Math.min(getPeerVolume(pendingFp) / 100, 1.0);
          monitorPeerAudio(pendingFp, audio);
        }
      } else if (track.kind === "video") {
        console.log("[SFU] video track received:", track.id, "stream:", stream.id);
        onSFUVideoTrack(stream, track);
      }
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const ci = ev.candidate.toJSON();
      invoke("send_sfu", {
        action: "sfu-ice",
        payload: { channel, candidate: ci.candidate, sdpMid: ci.sdpMid, sdpMLineIndex: ci.sdpMLineIndex },
        fingerprint: state.fingerprint,
      }).catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        clearTimeout(timer);
        resolve(true);
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        clearTimeout(timer);
        pc.close();
        sfuPc = null;
        resolve(false);
      }
    };

    // Ask server to join SFU room — server responds with sfu-offer over WS
    invoke("send_sfu", {
      action: "sfu-join",
      payload: { channel },
      fingerprint: state.fingerprint,
    }).catch(() => { clearTimeout(timer); resolve(false); });
  });
}

async function handleSFUMessage(msg: any) {
  switch (msg.type) {
    case "sfu-offer": {
      if (!sfuPc) return;
      // Server sends offer as: { type:"sfu-offer", sdp: "<json string>" }
      // or nested in payload. Parse defensively.
      let offerObj: RTCSessionDescriptionInit;
      try {
        const raw = msg.sdp ?? (typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload));
        offerObj = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch { return; }

      try {
        // Handle renegotiation: if we already have a local description, rollback first
        if (sfuPc.signalingState !== "stable") {
          await Promise.all([
            sfuPc.setLocalDescription({ type: "rollback" }),
            sfuPc.setRemoteDescription(new RTCSessionDescription(offerObj)),
          ]);
        } else {
          await sfuPc.setRemoteDescription(new RTCSessionDescription(offerObj));
        }
        const answer = await sfuPc.createAnswer();
        await sfuPc.setLocalDescription(answer);
        invoke("send_sfu", {
          action: "sfu-answer",
          payload: { channel: state.activeVoice, sdp: JSON.stringify(answer) },
          fingerprint: state.fingerprint,
        }).catch(() => {});
      } catch (e) { console.warn("SFU offer handling failed:", e); }
      break;
    }
    case "sfu-ice": {
      if (!sfuPc) return;
      // Candidate may be at top level or nested in payload
      const p = msg.payload ?? msg;
      try {
        await sfuPc.addIceCandidate(new RTCIceCandidate({
          candidate:     p.candidate ?? msg.candidate,
          sdpMid:        p.sdpMid    ?? msg.sdpMid,
          sdpMLineIndex: p.sdpMLineIndex ?? msg.sdpMLineIndex,
        }));
      } catch {}
      break;
    }
  }
}


// ── Screen share ──────────────────────────────────────────────────────────────

function showSharePicker() {
  if (!sfuPc || voiceMode !== "sfu") {
    alert("Screen share requires SFU connection."); return;
  }
  // If already sharing, stop instead
  if (screenStream) { stopScreenShare(); return; }

  const overlay = document.createElement("div");
  overlay.id = "share-picker-overlay";
  overlay.className = "share-picker-overlay";
  overlay.innerHTML = `
    <div class="share-picker-box">
      <h2>Share your screen</h2>
      <p class="settings-hint">Choose quality. Your GPU encodes — higher quality uses more upload.</p>
      <div class="quality-grid">
        ${QUALITY_PRESETS.map(([label], i) => `
          <button class="quality-btn ${i === 0 ? "selected" : ""}" data-idx="${i}">${label}</button>
        `).join("")}
      </div>
      <div class="share-picker-actions">
        <button class="btn-secondary" id="share-cancel-btn">Cancel</button>
        <button class="btn-primary"   id="share-start-btn">Start sharing</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let selectedIdx = 0;
  overlay.querySelectorAll(".quality-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll(".quality-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      selectedIdx = parseInt((btn as HTMLElement).dataset.idx!);
    });
  });
  document.getElementById("share-cancel-btn")!.addEventListener("click", () => overlay.remove());
  document.getElementById("share-start-btn")!.addEventListener("click", async () => {
    overlay.remove();
    await startScreenShare(selectedIdx);
  });
}

async function startScreenShare(presetIdx: number) {
  const [, w, h, fps] = QUALITY_PRESETS[presetIdx];
  const videoConstraints: MediaTrackConstraints = {};
  if (w > 0) { videoConstraints.width = { ideal: w }; videoConstraints.height = { ideal: h }; }
  if (fps > 0) { videoConstraints.frameRate = { ideal: fps, max: fps }; }

  try {
    screenStream = await (navigator.mediaDevices as any).getDisplayMedia({
      video: w > 0 ? videoConstraints : true,
      audio: false, // system audio causes echo — keep off
      selfBrowserSurface: "exclude",
    });
  } catch (e: any) {
    if (e.name !== "NotAllowedError") alert(`Screen capture failed: ${e.message}`);
    return;
  }

  // Add video track to the SFU peer connection
  const videoTrack = screenStream.getVideoTracks()[0];
  if (!videoTrack || !sfuPc) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; return; }

  screenSender = sfuPc.addTrack(videoTrack, screenStream);

  // Show our own screen in the grid immediately
  activeScreens.set(state.fingerprint, {
    stream: screenStream,
    label:  state.myNickname || state.fingerprint.slice(0, 8),
  });
  openScreenDrawer(); // explicitly open for sharer
  updateShareButton(true);

  // Broadcast via signaling hub so ALL peers in the room get notified (not just SFU peers)
  invoke("send_chat", {
    text: `__screen-start:${state.myNickname || state.fingerprint.slice(0, 8)}`,
    fingerprint: state.fingerprint,
    room: "quipu-main",
  }).catch(() => {});

  // Auto-stop when user clicks "Stop sharing" in browser UI
  videoTrack.addEventListener("ended", () => stopScreenShare());
}

function stopScreenShare() {
  screenStream?.getTracks().forEach(t => t.stop());
  screenStream = null;
  if (sfuPc && screenSender) {
    try { sfuPc.removeTrack(screenSender); } catch {}
  }
  screenSender = null;
  activeScreens.delete(state.fingerprint);
  renderScreenGrid();
  updateShareButton(false);
  invoke("send_chat", {
    text: "__screen-stop",
    fingerprint: state.fingerprint,
    room: "quipu-main",
  }).catch(() => {});
}

function updateShareButton(sharing: boolean) {
  const btn = document.getElementById("screen-share-btn");
  if (!btn) return;
  btn.textContent = sharing ? "⬡" : "⬡";
  btn.classList.toggle("sharing", sharing);
  btn.title = sharing ? "Stop sharing" : "Share screen";
}


// Called when we receive a video track from the SFU (someone else sharing)
function onSFUVideoTrack(stream: MediaStream, track: MediaStreamTrack) {
  console.log("[SFU] video track arrived, stream:", stream.id, "pending:", [...pendingScreenMeta.entries()]);
  // Always store by stream ID initially — __screen-start broadcast will re-key to fp
  const streamKey = `__stream:${stream.id}`;
  // Check if there's exactly one pending entry to auto-match (unambiguous case)
  const pendingEntries = [...pendingScreenMeta.entries()];
  let label = "Sharing...";
  let finalKey = streamKey;
  if (pendingEntries.length === 1) {
    const [fp, pendingLabel] = pendingEntries[0];
    if (!activeScreens.has(fp)) {
      finalKey = fp;
      label = pendingLabel;
      pendingScreenMeta.delete(fp);
      console.log("[SFU] matched stream to fp:", fp);
    }
  }
  activeScreens.set(finalKey, { stream, label });
  // Open drawer when:
  // 1. Track is unmuted (real screen share content flowing)
  // 2. OR we matched a pending __screen-start broadcast (label is set)
  if (!track.muted || label !== "Sharing...") {
    openScreenDrawer();
  } else {
    // Muted placeholder — just update the tab count silently
    renderScreenGrid();
  }
  track.addEventListener("ended", () => {
    for (const [k, v] of activeScreens) {
      if (v.stream === stream) { activeScreens.delete(k); if (focusedScreen === k) focusedScreen = null; break; }
    }
    renderScreenGrid();
  });
}

function onRemoteScreenStart(msg: any) {
  const fp    = msg.from ?? msg.payload?.from;
  const label = msg.payload?.label ?? displayName(fp);
  sounds.screenShare(); // someone started sharing
  console.log("[SFU] screen-start from:", fp, "label:", label, "activeScreens:", [...activeScreens.keys()]);
  // Find any __stream: entry not yet keyed to a real fp, re-key it
  const streamKey = [...activeScreens.keys()].find(k => k.startsWith("__stream:"));
  if (streamKey) {
    const val = activeScreens.get(streamKey)!;
    activeScreens.delete(streamKey);
    activeScreens.set(fp, { ...val, label });
    openScreenDrawer();
    requestAnimationFrame(() => {
      const vid = document.getElementById(`vid-${fp}`) as HTMLVideoElement | null;
      if (vid && vid.srcObject !== val.stream) vid.srcObject = val.stream;
    });
  } else if (activeScreens.has(fp)) {
    // Already keyed (track arrived first with correct fp) — just update label
    const val = activeScreens.get(fp)!;
    activeScreens.set(fp, { ...val, label });
    renderScreenGrid(); // update drawer in-place (already open)
  } else {
    // Track hasn't arrived yet — store metadata
    pendingScreenMeta.set(fp, label);
    console.log("[SFU] stored pending meta for:", fp);
  }
  updateScreenBar();
}

function onRemoteScreenStop(msg: any) {
  const fp = msg.from ?? msg.payload?.from;
  activeScreens.delete(fp);
  pendingScreenMeta.delete(fp);
  if (focusedScreen === fp) focusedScreen = null;
  renderScreenGrid();
}

// ── Screen grid renderer ──────────────────────────────────────────────────────

function updateScreenBar() {
  // Sidebar notification bar — shows who is sharing
  document.getElementById("screen-share-bar")?.remove();
  if (activeScreens.size === 0 || !state.activeVoice) return;
  const bar = document.createElement("div");
  bar.id = "screen-share-bar";
  bar.className = "screen-share-bar";
  const names = [...activeScreens.values()].map(s => s.label).filter(Boolean).join(", ") || "Someone";
  bar.innerHTML = `
    <div class="screen-bar-row">
      <span class="screen-bar-icon">🖥</span>
      <span class="screen-bar-label">${escapeHtml(names)}</span>
      <button class="screen-bar-btn" id="view-screens-btn">▶ Watch</button>
    </div>`;
  // Insert above voice channels section
  const vGroup = document.querySelector(".channel-group:last-of-type");
  vGroup?.parentElement?.insertBefore(bar, vGroup);
  document.getElementById("view-screens-btn")?.addEventListener("click", () => {
    if (!document.getElementById("screen-overlay")) renderScreenGrid();
  });
}

// Drawer state: false = closed, true = open, "collapsed" = tab visible but content hidden
let screenDrawerOpen: boolean | "collapsed" = false;

function openScreenDrawer() {
  screenDrawerOpen = true;
  renderScreenGrid();
}

function renderScreenGrid() {
  updateScreenBar();
  const existing = document.getElementById("screen-drawer");

  // Always show the drawer tab when in voice (SFU) — even when no one is sharing
  // This lets viewers open it without needing to share themselves
  const showDrawer = state.activeVoice && voiceMode === "sfu";

  if (!showDrawer) {
    existing?.remove();
    screenDrawerOpen = false;
    return;
  }

  // If no content and drawer is closed, just render the collapsed tab
  if (activeScreens.size === 0 && !screenDrawerOpen) {
    // Render tab-only drawer (collapsed, no panel)
    const drawer = existing ?? document.createElement("div");
    drawer.id = "screen-drawer";
    drawer.className = "screen-drawer collapsed";
    drawer.innerHTML = `
      <button class="screen-drawer-tab" id="screen-drawer-tab" title="Screen shares">
        🖥 ${activeScreens.size}
      </button>
      <div class="screen-drawer-panel" style="display:none"></div>`;
    if (!existing) document.body.appendChild(drawer);
    document.getElementById("screen-drawer-tab")?.addEventListener("click", () => {
      if (activeScreens.size > 0) { screenDrawerOpen = true; renderScreenGrid(); }
      // If no one sharing, clicking tab does nothing useful yet
    });
    return;
  }

  // If drawer was manually closed and no new share, keep it closed (tab only)
  if (!screenDrawerOpen && existing && activeScreens.size > 0) {
    // Update the tab count but keep panel closed
    const tab = existing.querySelector(".screen-drawer-tab");
    if (tab) tab.textContent = `🖥 ${activeScreens.size}`;
    return;
  }
  if (!screenDrawerOpen && !existing) {
    // Render collapsed tab only
    const drawer = document.createElement("div");
    drawer.id = "screen-drawer";
    drawer.className = "screen-drawer collapsed";
    drawer.innerHTML = `
      <button class="screen-drawer-tab" id="screen-drawer-tab" title="Screen shares (${activeScreens.size})">
        🖥 ${activeScreens.size}
      </button>
      <div class="screen-drawer-panel" style="display:none"></div>`;
    document.body.appendChild(drawer);
    document.getElementById("screen-drawer-tab")?.addEventListener("click", () => {
      if (activeScreens.size > 0) { screenDrawerOpen = true; renderScreenGrid(); }
    });
    return;
  }

  const focused = focusedScreen && activeScreens.has(focusedScreen) ? focusedScreen : null;

  const isCollapsed = screenDrawerOpen === "collapsed";
  const drawer = existing ?? document.createElement("div");
  drawer.id = "screen-drawer";
  drawer.className = `screen-drawer ${focused ? "focused-mode" : ""} ${isCollapsed ? "collapsed" : ""}`;
  drawer.innerHTML = `
    <button class="screen-drawer-tab" id="screen-drawer-tab" title="${isCollapsed ? "Expand" : "Collapse"}">
      🖥 ${activeScreens.size}
    </button>
    <div class="screen-drawer-panel">
      <div class="screen-drawer-header">
        <span class="screen-drawer-title">🖥 Screen shares (${activeScreens.size})</span>
        <button class="screen-drawer-collapse" id="screen-drawer-collapse" title="Collapse">‹</button>
        <button class="screen-drawer-close" id="screen-drawer-close" title="Close">✕</button>
      </div>
      <div class="screen-grid-inner">
        ${[...activeScreens.entries()].map(([fp, { label }]) => `
          <div class="screen-tile ${focused === fp ? "focused" : focused ? "hidden" : ""}"
               data-fp="${fp}" id="tile-${fp}">
            <div class="screen-tile-header">
              <span class="screen-tile-label">${escapeHtml(label)}</span>
              ${fp === state.fingerprint ? `<button class="stop-share-btn" title="Stop sharing">■ Stop</button>` : ""}
              <button class="focus-btn" title="${focused === fp ? "Back to grid" : "Expand"}">
                ${focused === fp ? "⊟" : "⊞"}
              </button>
            </div>
            <video class="screen-video" id="vid-${fp}" autoplay playsinline muted></video>
          </div>
        `).join("")}
      </div>
    </div>`;

  if (!existing) document.body.appendChild(drawer);

  // Attach streams
  activeScreens.forEach(({ stream }, fp) => {
    const vid = document.getElementById(`vid-${fp}`) as HTMLVideoElement | null;
    if (vid && vid.srcObject !== stream) vid.srcObject = stream;
  });

  // Tab toggle — expands collapsed drawer
  document.getElementById("screen-drawer-tab")?.addEventListener("click", () => {
    screenDrawerOpen = screenDrawerOpen === "collapsed" ? true : "collapsed";
    renderScreenGrid();
  });

  // Collapse — hides panel, shows tab
  document.getElementById("screen-drawer-collapse")?.addEventListener("click", () => {
    screenDrawerOpen = "collapsed";
    renderScreenGrid();
  });

  // Close = fully remove drawer
  document.getElementById("screen-drawer-close")?.addEventListener("click", () => {
    drawer.remove();
    screenDrawerOpen = false;
  });

  // Focus/expand buttons
  drawer.querySelectorAll(".focus-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const fp = (btn.closest(".screen-tile") as HTMLElement)?.dataset.fp!;
      focusedScreen = focusedScreen === fp ? null : fp;
      renderScreenGrid();
    });
  });

  // Stop share
  drawer.querySelectorAll(".stop-share-btn").forEach(btn => {
    btn.addEventListener("click", () => stopScreenShare());
  });

  // Double-click to expand
  drawer.querySelectorAll(".screen-tile").forEach(tile => {
    tile.addEventListener("dblclick", () => {
      const fp = (tile as HTMLElement).dataset.fp!;
      focusedScreen = focusedScreen === fp ? null : fp;
      renderScreenGrid();
    });
  });

  // Escape to un-focus
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape" && focusedScreen) { focusedScreen = null; renderScreenGrid(); }
  };
  document.removeEventListener("keydown", escHandler);
  document.addEventListener("keydown", escHandler);
}

// Scan receivers for live unmuted video tracks not yet shown.
// Called after SFU connect and after renegotiation.
function checkForNewVideoTracks() {
  if (!sfuPc) return;
  for (const recv of sfuPc.getReceivers()) {
    const track = recv.track;
    if (!track || track.kind !== "video" || track.readyState !== "live") continue;
    if (track.muted) continue; // placeholder transceiver, no real content
    let found = false;
    activeScreens.forEach(({ stream }) => {
      if (stream.getVideoTracks().some(t => t.id === track.id)) found = true;
    });
    if (!found) {
      console.log("[SFU] found unmuted video track:", track.id);
      const stream = new MediaStream([track]);
      onSFUVideoTrack(stream, track);
    }
  }
}

function leaveVoice() {
  const ch = state.activeVoice;
  state.activeVoice = null;
  voicePeers.clear();
  sounds.voiceLeave();
  // Remove screen drawer — no longer in voice
  document.getElementById("screen-drawer")?.remove();
  screenDrawerOpen = false;
  stopAfkDetection();
  stopSpeakingDetection();
  // Remove ourselves from channel tracking
  if (ch) {
    const cpSet = channelPeers.get(ch);
    if (cpSet) cpSet.delete(state.fingerprint);
  }
  // Notify others we left voice
  if (ch && state.connected) {
    invoke("send_chat", {
      text: `__voice-leave:${ch}`,
      fingerprint: state.fingerprint,
      room: "quipu-main",
    }).catch(() => {});
  }
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  // Stop screen share if active
  if (screenStream) stopScreenShare();
  if (sfuPc) {
    if (ch) {
      invoke("send_sfu", {
        action: "sfu-leave",
        payload: { channel: ch },
        fingerprint: state.fingerprint,
      }).catch(() => {});
    }
    sfuPc.close();
    sfuPc = null;
  }
  activeScreens.clear();
  focusedScreen = null;
  state.peers.forEach(p => { p.pc?.close(); state.peers.set(p.fp, { ...p, pc: null as any }); });
  document.getElementById("audio-container")?.remove();
  const voiceStatus = document.getElementById("voice-status");
  if (voiceStatus) voiceStatus.style.display = "none";
  renderSidebar();
}

// ── P2P WebRTC (fallback) ─────────────────────────────────────────────────────

function createOrGetPC(remoteFp: string, _isInitiator: boolean): RTCPeerConnection {
  const existing = state.peers.get(remoteFp);
  if (existing?.pc && existing.pc.connectionState !== "closed" && existing.pc.connectionState !== "failed") return existing.pc;
  const isInitiator = state.fingerprint > remoteFp;
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });
  localStream?.getTracks().forEach(track => { localStream && pc.addTrack(track, localStream); });
  pc.ontrack = (ev) => {
    let container = document.getElementById("audio-container");
    if (!container) { container = document.createElement("div"); container.id = "audio-container"; document.body.appendChild(container); }
    let audio = document.getElementById(`audio-${remoteFp}`) as HTMLAudioElement | null;
    if (!audio) { audio = document.createElement("audio"); audio.id = `audio-${remoteFp}`; audio.autoplay = true; container.appendChild(audio); }
    audio.srcObject = ev.streams[0];
    setPeerVolume(remoteFp, getPeerVolume(remoteFp));
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
  // Only process P2P offers when in P2P fallback mode
  if (!state.activeVoice || !localStream || voiceMode === "sfu") return;
  const existing = state.peers.get(msg.from);
  if (existing?.pc && existing.pc.connectionState !== "closed" && existing.pc.connectionState !== "failed") {
    try {
      await existing.pc.setRemoteDescription(new RTCSessionDescription(msg.payload));
      const answer = await existing.pc.createAnswer();
      await existing.pc.setLocalDescription(answer);
      await invoke("send_signal", { kind: "answer", to: msg.from, payload: answer, fingerprint: state.fingerprint, room: "quipu-main" });
    } catch (e) { console.warn("onRtcOffer existing PC failed:", e); }
    return;
  }
  const pc = new RTCPeerConnection({ iceServers: getIceServers() });
  localStream?.getTracks().forEach(track => { localStream && pc.addTrack(track, localStream); });
  pc.ontrack = (ev) => {
    let container = document.getElementById("audio-container");
    if (!container) { container = document.createElement("div"); container.id = "audio-container"; document.body.appendChild(container); }
    let audio = document.getElementById(`audio-${msg.from}`) as HTMLAudioElement | null;
    if (!audio) { audio = document.createElement("audio"); audio.id = `audio-${msg.from}`; audio.autoplay = true; container.appendChild(audio); }
    audio.srcObject = ev.streams[0];
    setPeerVolume(msg.from, getPeerVolume(msg.from));
    const sinkId = outputDeviceId || savedSpeakerId;
    if (sinkId && typeof (audio as any).setSinkId === "function") {
      (audio as any).setSinkId(sinkId).catch(console.warn);
    }
  };
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    invoke("send_signal", { kind: "candidate", to: msg.from, payload: ev.candidate.toJSON(), fingerprint: state.fingerprint, room: "quipu-main" }).catch(console.error);
  };
  pc.onconnectionstatechange = () => renderSidebar();
  state.peers.set(msg.from, { fp: msg.from, pc, muted: false });
  // In P2P mode, receiving an offer means they're in our voice channel
  if (state.activeVoice && voiceMode === "p2p") voicePeers.add(msg.from);
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
