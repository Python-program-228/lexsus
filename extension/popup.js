// AI Continuity Bridge — popup logic.

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const msg = document.getElementById("msg");
const code = document.getElementById("code");
const pairBtn = document.getElementById("pair");
const unpairBtn = document.getElementById("unpair");
const handoffBtn = document.getElementById("handoff");

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
  chrome.runtime.sendMessage({ type: "handoff-request" }, (res) => {
    msg.textContent = res?.ok
      ? "handoff sent — open chatgpt.com"
      : res?.error ?? "failed";
  });
});

refreshStatus();
setInterval(refreshStatus, 2000);