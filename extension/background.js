// AI Continuity Bridge — service worker (MV3) v2.0.
// Maintains the WebSocket to the desktop app (ws://127.0.0.1:45241),
// gates it with the 6-digit pairing code, and routes messages between
// the popup / content scripts and the app.
//
// Protocol v2: UUID-based request tracking, structured error codes,
// automatic timeouts with retry, and backwards compatibility with v1.

// Per-tool timeouts come from the shared spec table; a service worker is a
// separate JS context from the content scripts, so it loads it itself.
importScripts("tool-spec.js");
const SPEC = globalThis.ACBToolSpec;

const WS_URL = "ws://127.0.0.1:45241";
const PROTOCOL_VERSION = 2;

const TARGET_HOSTS = {
  chatgpt: "https://chatgpt.com/*",
  claudeai: "https://claude.ai/*",
  gemini: "https://gemini.google.com/*",
  grok: "https://grok.com/*",
};

// ── Request tracking ──────────────────────────────────────────────
const pendingRequests = new Map(); // id → { tool, timestamp, retries, timeout, tabId }
// Latest MCP tool list pushed by the app (replayed to tabs on demand).
let mcpTools = [];
const MAX_RETRIES = 1;
const REQUEST_TTL_MS = 60000;

function generateId() {
  return crypto.randomUUID();
}

function getToolTimeout(toolName) {
  return SPEC.timeoutFor(toolName);
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
    recordOutcome(id, "timeout");
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

// ── History ───────────────────────────────────────────────────────
//
// Persistent log of tool calls and their outcomes, capped so
// chrome.storage stays small. The dock's History view reads this; the
// desktop app's audit trail remains the authoritative record.
const HISTORY_KEY = "toolHistory";
const HISTORY_LIMIT = 200;
const HISTORY_OUTPUT_CAP = 4000;

function recordCall(id, toolName, args) {
  const detail = args?.path || args?.command || args?.name || "";
  chrome.storage.local.get(HISTORY_KEY, ({ [HISTORY_KEY]: list = [] }) => {
    list.push({
      id,
      tool: toolName,
      detail: String(detail).slice(0, 120),
      status: "running",
      ts: Date.now(),
    });
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
    chrome.storage.local.set({ [HISTORY_KEY]: list });
  });
}

function recordOutcome(id, status, output) {
  chrome.storage.local.get(HISTORY_KEY, ({ [HISTORY_KEY]: list = [] }) => {
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    entry.status = status;
    if (typeof output === "string") {
      entry.output =
        output.length > HISTORY_OUTPUT_CAP
          ? output.slice(0, HISTORY_OUTPUT_CAP) + "\n[output truncated]"
          : output;
    }
    chrome.storage.local.set({ [HISTORY_KEY]: list });
  });
}

// ── Tab routing ───────────────────────────────────────────────────
//
// A declared content script only injects when a page *loads*. So any tab that
// was already open when the extension was installed, reloaded, or updated has
// no receiver, and `sendMessage` rejects with "Receiving end does not exist" —
// during development that is every tab on every reload, and after an
// auto-update it is every user's open chat. So instead of dropping the message,
// inject on that failure and retry once.

/** Chrome match pattern → RegExp, for the `scheme://host/*` shapes we declare. */
function patternToRe(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// Read from the manifest at runtime so the file lists cannot drift from
// `content_scripts` — a stale copy here would inject the wrong bundle.
const CONTENT_SCRIPTS = chrome.runtime.getManifest().content_scripts.map((cs) => ({
  matches: cs.matches.map(patternToRe),
  js: cs.js ?? [],
  css: cs.css ?? [],
}));

// tabId → in-flight injection. Concurrent failed sends must not each inject,
// or the tab ends up with two copies of the UI listening to every message.
const injecting = new Map();

async function injectInto(tabId, url) {
  const cs = CONTENT_SCRIPTS.find((c) => c.matches.some((re) => re.test(url)));
  if (!cs) {
    console.warn(`[ACB] tab ${tabId} matches no content script: ${url}`);
    return false;
  }
  if (cs.css.length) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: cs.css });
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: cs.js });
  console.log(`[ACB] injected ${cs.js.join(", ")} into tab ${tabId}`);
  return true;
}

/**
 * Deliver one message to one tab, injecting first if nothing is listening.
 * Injection is only attempted *after* a send fails, so a tab that already has
 * a live content script never receives a second copy.
 */
async function deliver(tab, msg) {
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch {
    // No receiver yet — fall through and inject.
  }
  // A tab still loading gets the manifest's declared script at
  // document_idle; injecting now would leave two live copies scanning
  // the same transcript (every tool call sent and executed twice). The
  // fresh script pulls its own status via get-status, so dropping this
  // one message costs nothing.
  if (tab.status === "loading") return false;
  try {
    let pending = injecting.get(tab.id);
    if (!pending) {
      pending = injectInto(tab.id, tab.url).finally(() => injecting.delete(tab.id));
      injecting.set(tab.id, pending);
    }
    if (!(await pending)) return false;
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch (err) {
    console.warn(`[ACB] tab ${tab.id} unreachable: ${err.message}`);
    return false;
  }
}

function forwardToTabs(msg, preferredHost) {
  const urls = preferredHost ? [preferredHost] : Object.values(TARGET_HOSTS);
  chrome.tabs.query({ url: urls }, (tabs) => {
    if (tabs?.length) {
      for (const t of tabs) void deliver(t, msg);
      return;
    }
    if (!preferredHost) {
      console.log("[ACB] no web-AI tab is open — nothing to deliver to");
      return;
    }
    // The requested target isn't open; any paired chat beats dropping the call.
    console.log(`[ACB] no tab for ${preferredHost} — broadcasting to all targets`);
    forwardToTabs(msg, null);
  });
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
  // `!!socket` would read "connected" while the handshake is still in
  // flight — the dock is only truly live once pairing succeeded.
  const connected = paired && !!socket && socket.readyState === WebSocket.OPEN;
  // runtime.sendMessage reaches the popup and other extension pages but,
  // per Chrome's message-passing rules, never content scripts — those
  // need tabs.sendMessage. Without the broadcast, every dock in every
  // tab stays on its initial "connecting…" forever.
  chrome.runtime
    .sendMessage({ type: "status", paired, connected })
    .catch(() => {});
  forwardToTabs({ type: "status", paired, connected }, null);
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
        // Ask for the app's MCP tool list right away so the AI's manifest
        // can include namespaced mcp__* tools.
        socket.send(JSON.stringify({ type: "mcp_tools" }));
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
        // "pending" is informational (the app now sends it as soon as a
        // call parks on a user approval): the request is still alive, so
        // keep the timeout watchdog running until the FINAL result.
        if (msg.status !== "pending" && msg.id && pendingRequests.has(msg.id)) {
          untrackRequest(msg.id);
        }
        recordOutcome(msg.id, msg.status, msg.result?.output ?? msg.error?.message);
        forwardToTabs(msg, null);
        break;
      }

      // ── Protocol v2: tool_stream (live command output) ──────
      case "tool_stream":
        forwardToTabs(msg, null);
        break;

      // ── MCP: live tool list from the app ─────────────────────
      case "mcp_tools": {
        if (Array.isArray(msg.tools)) {
          mcpTools = msg.tools;
          // Register in the service worker's own tool-spec copy too, so
          // per-tool timeouts (trackRequest) apply to MCP calls.
          globalThis.ACBToolSpec?.registerMcpTools(msg.tools);
        }
        forwardToTabs(msg, null);
        break;
      }

      // ── lexsus-agent/1: task state changed in the app ────────
      case "task_result":
        forwardToTabs(msg, null);
        break;

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

    // Persistent tool history for the dock's History view.
    case "get-history": {
      chrome.storage.local.get(HISTORY_KEY, ({ [HISTORY_KEY]: list }) =>
        sendResponse(list || []),
      );
      return true; // async sendResponse
    }

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
      recordCall(id, toolName, toolArgs);
      socket.send(JSON.stringify(v2Msg));
      sendResponse({ ok: true, id });
      break;
    }

    // ── Protocol v2: tool_approve ──────────────────────────────
    // Approvals resolve in the desktop app only. The host page's DOM is
    // untrusted: a synthetic click on an in-page Allow button must never
    // be able to execute a gated tool, so this relay is closed.
    case "approve":
      sendResponse({
        ok: false,
        error: "approvals are handled in the desktop app",
      });
      break;

    case "handoff-request":
      console.log("[ACB] handoff-request received", { hasSocket: !!socket, open: socket?.readyState === WebSocket.OPEN, paired });
      if (socket && socket.readyState === WebSocket.OPEN && paired) {
        socket.send(JSON.stringify({ type: "handoff-request" }));
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "not paired" });
      }
      break;

    // ── Protocol v2: cancel ────────────────────────────────────
    // The content script asks to abort a running tool call; the app
    // kills the processes owned by that request id.
    case "cancel": {
      if (socket && socket.readyState === WebSocket.OPEN && paired) {
        socket.send(JSON.stringify({ type: "cancel", id: msg.id }));
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "not paired" });
      }
      break;
    }

    // ── MCP tools for the content scripts ──────────────────────
    // Reply with the cached list immediately; ask the app for a fresh
    // one in the background (the reply arrives as an "mcp_tools" frame
    // and is forwarded to tabs).
    case "get-mcp-tools": {
      if (socket && socket.readyState === WebSocket.OPEN && paired) {
        socket.send(JSON.stringify({ type: "mcp_tools" }));
      }
      sendResponse(mcpTools);
      break;
    }

    // ── lexsus-agent/1: task control relay ─────────────────────
    case "task_create":
    case "task_status":
    case "task_pause":
    case "task_resume":
    case "task_cancel": {
      if (socket && socket.readyState === WebSocket.OPEN && paired) {
        socket.send(
          JSON.stringify({
            type: msg.type,
            id: msg.id || generateId(),
            task_id: msg.task_id,
            title: msg.title,
            objective: msg.objective,
          }),
        );
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "not paired" });
      }
      break;
    }

    // Prime an already-open chat with the tool manifest. Without this the
    // tool list only ever reaches a chat that received a handoff.
    case "send-manifest":
      forwardToTabs({ type: "send-manifest" }, hostForTarget(msg.target));
      sendResponse({ ok: true });
      break;
    default:
      sendResponse({ ok: false });
  }
  return false;
});

connect();
statusUpdate();
console.log("[ACB] background.js loaded, service worker active");
