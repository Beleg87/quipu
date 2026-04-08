import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles/main.css";

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  const version = await invoke<string>("get_version");
  console.log(`Quipu v${version} starting`);

  const app = document.getElementById("app")!;
  app.innerHTML = buildShell();

  setupNav();
  showView("home");
}

// ── Shell layout ──────────────────────────────────────────────────────────────

function buildShell(): string {
  return `
  <div class="shell">
    <aside class="sidebar">
      <div class="logo">
        <span class="logo-knot">⬡</span>
        <span class="logo-text">quipu</span>
      </div>
      <nav class="nav">
        <button class="nav-btn active" data-view="home">Home</button>
        <button class="nav-btn" data-view="voice">Voice</button>
        <button class="nav-btn" data-view="chat">Chat</button>
        <button class="nav-btn" data-view="settings">Settings</button>
      </nav>
      <div class="identity-badge">
        <span class="dot connected"></span>
        <span id="fingerprint-display">— not connected —</span>
      </div>
    </aside>
    <main class="content">
      <div id="view-home"   class="view active"><h1>Welcome to Quipu</h1><p>Decentralized voice & chat. No accounts. No servers you don't own.</p></div>
      <div id="view-voice"  class="view"><h1>Voice</h1><p>Coming in Phase 1.</p></div>
      <div id="view-chat"   class="view"><h1>Chat</h1><p>Coming in Phase 1.</p></div>
      <div id="view-settings" class="view"><h1>Settings</h1><p>Keypair management coming soon.</p></div>
    </main>
  </div>
  `;
}

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
}

init();
