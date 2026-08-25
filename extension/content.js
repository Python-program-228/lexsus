// AI Continuity Bridge — chatgpt.com content script.
// Renders the handoff card and tool widgets, captures web-AI tool
// requests written in the chat, and inserts tool results back into the
// composer.

const HANDOFF_PROMPT = (h) =>
  [
    `# Continue this task (AI Continuity Bridge handoff)`,
    ``,
    `Objective: ${h.objective}`,
    `Progress: ${h.progress_percent}% · Files changed: ${h.files_changed} · Errors remaining: ${h.errors_remaining}`,
    `Next step: ${h.next_step ?? "review the project state"}`,
    h.files && h.files.length > 0 ? `Files involved: ${h.files.join(", ")}` : "",
    h.context ? `Task context so far: ${h.context}` : "",
    h.end_reason ? `Where the previous session stopped: ${h.end_reason}` : "",
    ``,
    `You are now the coding agent for the local project on the paired machine.`,
    `To act on the real filesystem you may use these tools, one per line:`,
    `read_file("path")`,
    `run_command("shell command")`,
    `list_directory("path")`,
    `git_status`,
    ``,
    `For write_file — and ANY tool whose argument spans multiple lines — you MUST instead emit an acb block containing one JSON object:`,
    '```acb',
    '{"tool":"write_file","path":"src/example.ts","content":"<entire new file content>"}',
    '```',
    ``,
    `Each tool call is executed locally by the bridge and the real result will be returned here. Never claim to have read or written files without the tool results.`,
  ]
    .filter(Boolean)
    .join("\n");

// --- composer helpers ---------------------------------------------------------

function findComposer() {
  return (
    document.querySelector("#prompt-textarea") ||
    document.querySelector("div[contenteditable='true']") ||
    document.querySelector("textarea")
  );
}

function insertIntoComposer(text) {
  const el = findComposer();
  if (!el) return false;
  el.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    sel.selectAllChildren(el);
    sel.collapseToEnd();
  }
  if (el.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    setter.call(el, el.value + text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
}

function submitComposer() {
  const btn =
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[aria-label="Send prompt"]') ||
    document.querySelector('button[aria-label="Send message"]') ||
    document.querySelector("#composer-submit-button");
  if (btn) {
    btn.click();
    return true;
  }
  // Last resort: Enter on the focused composer.
  const el = findComposer();
  if (el) {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
      }),
    );
    return true;
  }
  return false;
}

// --- tool capture -------------------------------------------------------------

const TOOL_RE = [
  { kind: "ReadFile", re: /read_file\s*[(:]\s*["']([^"'\s)]+)/i },
  {
    kind: "WriteFile",
    re: /write_file\s*[(:]\s*["']([^"']+)["']\s*[,)\s]\s*["']([\s\S]*?)["']\s*\)?/i,
  },
  { kind: "RunCommand", re: /run_command\s*[(:]\s*["']?([^"'\n]+)["']?\s*\)?/i },
  { kind: "ListDirectory", re: /list_directory\s*[(:]\s*["']([^"']+)["']/i },
  { kind: "GitStatus", re: /git_status\b/i },
];

// Fenced acb blocks: ```acb\n{"tool":"write_file","path":"...","content":"..."}\n```
// Chat UIs render fences as styled <pre> elements, so the literal ```
// never reaches textContent — instead we scan for JSON objects carrying
// a "tool"/"name" key and pull each one out with a string-aware,
// balanced-brace matcher (multi-line content safe).
const TOOL_KEY_RE = /["'](?:tool|name)["']\s*:/gi;

function balancedObjectAt(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // still streaming — retried on the next scan pass
}

function parseJsonBlock(body) {
  let obj;
  try {
    obj = JSON.parse(body.trim());
  } catch {
    return null;
  }
  const raw = String(obj.tool ?? obj.name ?? "");
  const name = raw.toLowerCase().replace(/[\s-]/g, "_");
  switch (name) {
    case "read_file":
      return typeof obj.path === "string"
        ? { ReadFile: { path: obj.path } }
        : null;
    case "write_file":
      return typeof obj.path === "string"
        ? { WriteFile: { path: obj.path, content: String(obj.content ?? "") } }
        : null;
    case "run_command":
      return typeof obj.command === "string"
        ? { RunCommand: { command: obj.command } }
        : null;
    case "list_directory":
      return typeof obj.path === "string"
        ? { ListDirectory: { path: obj.path } }
        : null;
    case "git_status":
      return { GitStatus: null };
    default:
      return null;
  }
}

// Extract acb tool objects from free text. Returns the tools plus the
// text with those objects blanked out (so the line scanner can't
// double-capture their contents).
function extractAcbTools(text) {
  const tools = [];
  const blanks = [];
  TOOL_KEY_RE.lastIndex = 0;
  let k;
  while ((k = TOOL_KEY_RE.exec(text)) !== null) {
    const start = text.lastIndexOf("{", k.index);
    if (start === -1 || k.index - start > 40) continue;
    const objText = balancedObjectAt(text, start);
    if (!objText) continue;
    const tool = parseJsonBlock(objText);
    if (tool) {
      tools.push(tool);
      blanks.push([start, start + objText.length]);
      TOOL_KEY_RE.lastIndex = start + objText.length;
    }
  }
  let rest = text;
  for (let i = blanks.length - 1; i >= 0; i--) {
    rest =
      rest.slice(0, blanks[i][0]) +
      " ".repeat(blanks[i][1] - blanks[i][0]) +
      rest.slice(blanks[i][1]);
  }
  return { tools, rest };
}

function parseToolLine(line) {
  for (const { kind, re } of TOOL_RE) {
    const m = line.match(re);
    if (!m) continue;
    switch (kind) {
      case "ReadFile":
        return { ReadFile: { path: m[1] } };
      case "WriteFile":
        return { WriteFile: { path: m[1], content: m[2] } };
      case "RunCommand":
        return { RunCommand: { command: m[1] } };
      case "ListDirectory":
        return { ListDirectory: { path: m[1] } };
      case "GitStatus":
        return { GitStatus: null };
    }
  }
  return null;
}

// Streaming messages are rescanned as they grow — signatures keep each
// tool call firing exactly once, even across format changes.
const sentSigs = new Set();
function sendTool(tool) {
  if (!tool) return;
  const sig = JSON.stringify(tool);
  if (sentSigs.has(sig)) return;
  sentSigs.add(sig);
  if (sentSigs.size > 200) sentSigs.delete(sentSigs.values().next().value);
  chrome.runtime.sendMessage({ type: "tool", tool }).catch(() => {});
}

let lastScanned = "";
const scan = () => {
  const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  const text = last.textContent;
  if (text === lastScanned) return;
  lastScanned = text;

  // 1) Structured acb JSON blocks first (multi-line safe).
  const { tools, rest } = extractAcbTools(text);
  for (const tool of tools) sendTool(tool);

  // 2) Bare-line fallback over everything outside those objects.
  for (const line of rest.split("\n")) {
    sendTool(parseToolLine(line.trim()));
  }
};

const observer = new MutationObserver(() => {
  clearTimeout(observer._t);
  observer._t = setTimeout(scan, 800);
});
observer.observe(document.body, { childList: true, subtree: true });

// --- widgets ------------------------------------------------------------------

function ensureRoot() {
  let root = document.getElementById("acb-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "acb-root";
    root.style.cssText = `
      position: fixed; z-index: 2147483647; font-family: system-ui, sans-serif;
      left: 16px; right: 16px; top: 16px; display: flex; flex-direction: column; gap: 8px;
      pointer-events: none;
    `;
    document.body.appendChild(root);
  }
  return root;
}

function card(html) {
  const el = document.createElement("div");
  el.style.cssText = `
    pointer-events: auto; background: #0d0d0d; border: 1px solid #333;
    border-radius: 10px; padding: 10px 12px; color: #e6e6e6; font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); max-width: 640px;
  `;
  el.innerHTML = html;
  return el;
}

const TARGET_LABEL = {
  claudeai: "Continue with Claude.ai",
  gemini: "Continue with Gemini",
  chatgpt: "Continue with ChatGPT",
};

function showHandoffCard(h) {
  const root = ensureRoot();
  const label = TARGET_LABEL[h.target] || TARGET_LABEL.chatgpt;
  const el = card(`
    <div style="font-weight:700;margin-bottom:6px;">Bridge handoff ready</div>
    <div style="color:#9a9a9a;margin-bottom:4px;">${h.objective}</div>
    <div style="margin-bottom:8px;">
      <b style="color:#4ade80;">${h.progress_percent}%</b> progress ·
      <b>${h.files_changed}</b> files changed ·
      <b style="color:#f87171;">${h.errors_remaining}</b> errors remaining
      ${h.next_step ? `<div style="color:#93c5fd;margin-top:4px;">next: ${h.next_step}</div>` : ""}
      ${h.context ? `<div style="color:#9a9a9a;margin-top:4px;">${escapeHtml(h.context.slice(0, 200))}</div>` : ""}
    </div>
    <button id="acb-continue" style="background:#2f6feb;color:#fff;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;">
      ${label}
    </button>
  `);
  const go = () => {
    const inserted = insertIntoComposer(HANDOFF_PROMPT(h));
    if (inserted && h.auto) {
      // Give the composer a beat to settle, then submit.
      setTimeout(submitComposer, 300);
    }
    el.remove();
  };
  el.querySelector("#acb-continue").addEventListener("click", go);
  root.appendChild(el);
  if (h.auto) go();
}

function showToolWidget(msg) {
  const root = ensureRoot();
  const r = msg.result;
  const summary = r.pending ? `⏳ ${r.pending}` : r.ok ? `✅ ${(r.output ?? "").slice(0, 2000)}` : `❌ ${r.error}`;
  const el = card(`
    <div style="font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto;">${escapeHtml(summary)}</div>
    <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;">
      ${r.pending
        ? `<button id="acb-allow" style="background:#059669;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;">Allow</button>
           <button id="acb-deny" style="background:#b91c1c;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;">Deny</button>`
        : `<button id="acb-insert" style="background:#2f6feb;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;">Insert result into chat</button>`}
    </div>
  `);
  const allow = el.querySelector("#acb-allow");
  if (allow) {
    allow.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "approve", id: msg.id, allow: true });
      el.remove();
    });
  }
  const deny = el.querySelector("#acb-deny");
  if (deny) {
    deny.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "approve", id: msg.id, allow: false });
      el.remove();
    });
  }
  const insert = el.querySelector("#acb-insert");
  if (insert) {
    insert.addEventListener("click", () => {
      insertIntoComposer((r.ok ? r.output : r.error) ?? "");
      el.remove();
    });
  }
  root.appendChild(el);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "handoff" && msg.payload) {
    showHandoffCard(msg.payload);
  }
  if (msg.type === "tool-result" && msg.result) {
    showToolWidget(msg);
  }
});