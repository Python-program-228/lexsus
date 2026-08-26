// AI Continuity Bridge — service worker (MV3) v2.0.
// Maintains the WebSocket to the desktop app (ws://127.0.0.1:45241),
// gates it with the 6-digit pairing code, and routes messages between
// the popup / content scripts and the app.
//
// Protocol v2: UUID-based request tracking, structured error codes,
// automatic timeouts with retry, and backwards compatibility with v1.

const WS_URL = "ws://127.0.0.1:45241";
const PROTOCOL_VERSION = 2;

const TARGET_HOSTS = {
  chatgpt: "https://chatgpt.com/*",
  claudeai: "https://claude.ai/*",
  gemini: "https://gemini.google.com/*",
};

// ── Request tracking ──────────────────────────────────────────────
const pendingRequests = new Map(); // id → { tool, timestamp, retries, timeout, tabId }
const TOOL_TIMEOUTS = {
  read_file: 10000,
  write_file: 15000,
  run_command: 120000,
  list_directory: 10000,
  search_files: 15000,
  git_status: 10000,
};
const MAX_RETRIES = 1;
const REQUEST_TTL_MS = 60000;

function generateId() {
  return crypto.randomUUID();
}

function getToolTimeout(toolName) {
  return TOOL_TIMEOUTS[toolName] || 15000;
}

function trackRequest(id, tool, tabId) {
  const toolName = tool.name || tool;
  const timeout = getToolTimeout(toolName);
  pendingRequests.set(id, {
    tool,
    timestamp: Date.now(),
    retries: 0,
    timeout: setTimeout(() => handleTimeout(id), timeout),
    tabId,
  });
}

function untrackRequest(id) {
  const req = pendingRequests.get(id);
  if (req) {
    clearTimeout(req.timeout);
    pendingRequests.delete(id);
  }
}

function handleTimeout(id) {
  const req = pendingRequests.get(id);
  if (!req) return;

  if (req.retries < MAX_RETRIES) {
    req.retries++;
    req.timeout = setTimeout(() => handleTimeout(id), getToolTimeout(req.tool.name || req.tool));
    // Resend the tool call
    const v2Msg = {
      id,
      type: "tool_call",
      tool: req.tool.name || req.tool,
      arguments: req.tool.arguments || {},
      timestamp: Date.now(),
      retry: req.retries,
    };
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(v2Msg));
    }
  } else {
    // Final timeout - notify content script
    forwardToTabs(
      {
        type: "tool_result",
        id,
        status: "timeout",
        error: { code: "TIMEOUT", message: "Request timed out after retries" },
      },
      null,
    );
    pendingRequests.delete(id);
  }
}

// Clean up stale requests (belt-and-suspenders)
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pendingRequests) {
    if (now - req.timestamp > REQUEST_TTL_MS) {
      untrackRequest(id);
    }
  }
}, 30000);

// ── Tab routing ───────────────────────────────────────────────────

function forwardToTabs(msg, preferredHost) {
  const send = (url) => {
    chrome.tabs.query({ url }, (tabs) => {
      console.log(`[ACB] forwardToTabs: url="${url}" found ${tabs?.length ?? 0} tabs`);
      for (const t of tabs) {
        console.log(`[ACB]   sending to tab ${t.id} url=${t.url}`);
        chrome.tabs.sendMessage(t.id, msg).catch((err) => {
          console.warn(`[ACB]   sendMessage failed for tab ${t.id}:`, err.message);
        });
      }
    });
  };
  if (preferredHost) {
    chrome.tabs.query({ url: preferredHost }, (tabs) => {
      console.log(`[ACB] forwardToTabs: preferredHost="${preferredHost}" found ${tabs?.length ?? 0} tabs`);
      if (tabs && tabs.length > 0) {
        for (const t of tabs) {
          console.log(`[ACB]   sending to tab ${t.id} url=${t.url}`);
          chrome.tabs.sendMessage(t.id, msg).catch((err) => {
            console.warn(`[ACB]   sendMessage failed for tab ${t.id}:`, err.message);
          });
        }
      } else {
        console.log("[ACB] no preferred tabs found, broadcasting to all targets");
        for (const url of Object.values(TARGET_HOSTS)) send(url);
      }
    });
  } else {
    for (const url of Object.values(TARGET_HOSTS)) send(url);
  }
}

function hostForTarget(target) {
  return TARGET_HOSTS[target] || TARGET_HOSTS.chatgpt;
}

// ── WebSocket connection ──────────────────────────────────────────

let socket = null;
let paired = false;
let serverVersion = null;
let reconnectDelay = 1000;
let pingMissed = 0;
let pingTimer = null;

function statusUpdate() {
  chrome.runtime
    .sendMessage({ type: "status", paired, connected: !!socket })
    .catch(() => {});
}

function connect() {
  if (socket) return;
  console.log("[ACB] connect() called", { paired, stored: !!chrome.storage });
  try {
    socket = new WebSocket(WS_URL);
  } catch (e) {
    console.warn("[ACB] WebSocket construction failed", e);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    console.log("[ACB] WebSocket connected");
    reconnectDelay = 1000;
    pingMissed = 0;
    chrome.storage.local.get("pairCode", ({ pairCode }) => {
      if (pairCode && socket) {
        socket.send(
          JSON.stringify({
            type: "pair",
            code: pairCode,
            proto: PROTOCOL_VERSION,
          }),
        );
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
        serverVersion = msg.server_version || null;
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

      // ── Protocol v2: tool_result ────────────────────────────
      case "tool_result": {
        // Track the request if we have it
        if (msg.id && pendingRequests.has(msg.id)) {
          untrackRequest(msg.id);
        }
        forwardToTabs(msg, null);
        break;
      }

      // ── Protocol v1: tool-result (legacy) ───────────────────
      case "tool-result": {
        // Convert to v2 format for content scripts
        const v2Msg = {
          type: "tool_result",
          id: String(msg.id || ""),
          status: msg.result?.ok ? "success" : msg.result?.pending ? "pending" : "error",
          result: msg.result?.ok ? { output: msg.result.output } : null,
          error: msg.result?.error
            ? { code: "EXECUTION_FAILED", message: msg.result.error }
            : null,
          meta: null,
        };
        if (msg.id && pendingRequests.has(msg.id)) {
          untrackRequest(String(msg.id));
        }
        forwardToTabs(v2Msg, null);
        break;
      }

      case "handoff":
        console.log("[ACB] handoff received from Rust, forwarding to tabs", { target: msg.payload?.target });
        forwardToTabs(msg, hostForTarget(msg.payload && msg.payload.target));
        break;
      case "handoff-error":
        console.log("[ACB] handoff-error from Rust:", msg.error);
        forwardToTabs(msg, null);
        break;
    }
  };

  socket.onclose = () => {
    console.log("[ACB] WebSocket closed");
    socket = null;
    paired = false;
    serverVersion = null;
    clearInterval(pingTimer);
    // Clear all pending requests on disconnect
    for (const [id, req] of pendingRequests) {
      clearTimeout(req.timeout);
    }
    pendingRequests.clear();
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

// ── Message handling ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[ACB] message received:", msg.type);
  switch (msg.type) {
    case "pair": {
      chrome.storage.local.set({ pairCode: msg.code });
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "pair",
            code: msg.code,
            proto: PROTOCOL_VERSION,
          }),
        );
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
      sendResponse({ paired, connected: !!socket, serverVersion });
      break;

    // ── Protocol v2: tool_call ─────────────────────────────────
    case "tool": {
      if (!socket || socket.readyState !== WebSocket.OPEN || !paired) {
        sendResponse({ ok: false, error: "not paired with the desktop app" });
        break;
      }
      const id = generateId();
      const toolName = msg.tool?.name || msg.tool;
      const toolArgs = msg.tool?.arguments || msg.tool;

      // Build v2 tool_call message
      const v2Msg = {
        id,
        type: "tool_call",
        tool: toolName,
        arguments: toolArgs,
        timestamp: Date.now(),
      };

      trackRequest(id, { name: toolName, arguments: toolArgs }, sender.tab?.id);
      socket.send(JSON.stringify(v2Msg));
      sendResponse({ ok: true, id });
      break;
    }

    // ── Protocol v2: tool_approve ──────────────────────────────
    case "approve": {
      const approveId = msg.id;
      if (socket && socket.readyState === WebSocket.OPEN) {
        // Try v2 format first
        socket.send(
          JSON.stringify({
            id: approveId,
            type: "tool_approve",
            allow: !!msg.allow,
            timestamp: Date.now(),
          }),
        );
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
      break;
    }

    case "handoff-request":
      console.log("[ACB] handoff-request received", { hasSocket: !!socket, open: socket?.readyState === WebSocket.OPEN, paired });
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
console.log("[ACB] background.js loaded, service worker active");
