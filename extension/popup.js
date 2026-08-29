// AI Continuity Bridge — popup logic.

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const msg = document.getElementById("msg");
const code = document.getElementById("code");
const pairBtn = document.getElementById("pair");
const unpairBtn = document.getElementById("unpair");
const handoffBtn = document.getElementById("handoff");
const manifestBtn = document.getElementById("manifest");

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "get-status" }, (res) => {
    const connected = !!res?.connected;
    const paired = !!res?.paired;
    dot.className = "dot" + (connected && paired ? " on" : "");
    statusText.textContent = !connected
      ? "desktop app not reachable"
      : paired
        ? "paired — ready"
        : "connected — enter the code to pair";
  });
}

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "status") refreshStatus();
});

pairBtn.addEventListener("click", () => {
  const c = code.value.trim();
  if (c.length !== 6) {
    msg.textContent = "enter the 6-digit code";
    return;
  }
  chrome.runtime.sendMessage({ type: "pair", code: c }, (res) => {
    msg.textContent = res?.ok ? "pairing…" : res?.error ?? "failed";
    if (res?.ok) setTimeout(refreshStatus, 500);
  });
});

unpairBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "unpair" });
  msg.textContent = "unpaired";
  refreshStatus();
});

handoffBtn.addEventListener("click", () => {
  msg.textContent = "sending handoff\u2026";
  let replied = false;
  chrome.runtime.sendMessage({ type: "handoff-request" }, (res) => {
    if (replied) return;
    replied = true;
    msg.textContent = res?.ok
      ? "handoff sent \u2014 open your web AI tab"
      : res?.error ?? "failed";
  });
  setTimeout(() => {
    if (!replied) {
      replied = true;
      msg.textContent = "no response from extension \u2014 try reloading";
    }
  }, 3000);
});

// Prime an open chat with the tool list. Without this, a chat only learns
// which tools exist if it received a handoff.
//
// Keyed by hostname fragment, mirroring TARGET_HOSTS in background.js. A tab
// on none of them falls through to chatgpt, which is also the default target.
const TARGET_BY_URL = [
  ["claude.ai", "claudeai"],
  ["gemini.google.com", "gemini"],
  ["grok.com", "grok"],
  ["chatgpt.com", "chatgpt"],
];

manifestBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs?.[0]?.url ?? "";
    const target = TARGET_BY_URL.find(([frag]) => url.includes(frag))?.[1] ?? "chatgpt";
    chrome.runtime.sendMessage({ type: "send-manifest", target }, (res) => {
      msg.textContent = res?.ok ? "tool manifest sent" : (res?.error ?? "failed");
    });
  });
});

refreshStatus();
setInterval(refreshStatus, 2000);