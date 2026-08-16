// AI Continuity Bridge — service worker (MV3).
// Maintains the WebSocket to the desktop app (ws://127.0.0.1:45241),
// gates it with the 6-digit pairing code, and routes messages between
// the popup / chatgpt.com content script and the app.

const WS_URL = "ws://127.0.0.1:45241";

let socket = null;
let paired = false;
let reconnectDelay = 1000;
let pingMissed = 0;
let pingTimer = null;
let toolId = 0;

function statusUpdate() {
  chrome.runtime.sendMessage({ type: "status", paired, connected: !!socket }).catch(() => {});
}

function connect() {
  if (socket) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectDelay = 1000;
    pingMissed = 0;
    chrome.storage.local.get("pairCode", ({ pairCode }) => {
      if (pairCode && socket) {
        socket.send(JSON.stringify({ type: "pair", code: pairCode }));
      }
    });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        pingMissed += 1;
        socket.send(JSON.stringify({ type: "ping" }));
        if (pingMissed > 3) {
          socket.close();
        }
      }
    }, 15000);
    statusUpdate();
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "pair-ok":
        paired = true;
        statusUpdate();
        break;
      case "pair-error":
        paired = false;
        chrome.storage.local.remove("pairCode");
        statusUpdate();
        break;
      case "pong":
        pingMissed = 0;
        break;
      case "tool-result":
        chrome.tabs.query({ url: "https://chatgpt.com/*" }, (tabs) => {
          for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, msg).catch(() => {});
          }
        });
        break;
      case "handoff":
        chrome.tabs.query({ url: "https://chatgpt.com/*" }, (tabs) => {
          for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, msg).catch(() => {});
          }
        });
        break;
    }
  };

  socket.onclose = () => {
    socket = null;
    paired = false;
    clearInterval(pingTimer);
    statusUpdate();
    scheduleReconnect();
  };

  socket.onerror = () => {
    if (socket) socket.close();
  };
}

function scheduleReconnect() {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case "pair": {
      chrome.storage.local.set({ pairCode: msg.code });
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "pair", code: msg.code }));
        sendResponse({ ok: true });
      } else {
        connect();
        sendResponse({ ok: false, error: "app not reachable — retrying" });
      }
      break;
    }
    case "unpair":
      chrome.storage.local.remove("pairCode");
      paired = false;
      if (socket) socket.close();
      statusUpdate();
      sendResponse({ ok: true });
      break;
    case "get-status":
      sendResponse({ paired, connected: !!socket });
      break;
    case "tool": {
      if (!socket || socket.readyState !== WebSocket.OPEN || !paired) {
        sendResponse({ ok: false, error: "not paired with the desktop app" });
        break;
      }
      const id = ++toolId;
      socket.send(JSON.stringify({ type: "tool", id, tool: msg.tool }));
      sendResponse({ ok: true, id });
      break;
    }
    case "approve": {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "approve", id: msg.id, allow: !!msg.allow }));
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      break;
    }
    case "handoff-request":
      if (socket && socket.readyState === WebSocket.OPEN && paired) {
        socket.send(JSON.stringify({ type: "handoff-request" }));
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "not paired" });
      }
      break;
    default:
      sendResponse({ ok: false });
  }
  return false;
});

connect();
statusUpdate();