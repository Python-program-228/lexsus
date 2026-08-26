// AI Continuity Bridge — chatgpt.com content script v2.0.
// Premium dark-mode UI: status pill, tool cards, result blocks, terminal.
// Injects styles.css and ui-components.js, then renders widgets using
// the shared component library.

(() => {
  "use strict";

  // ui-components.js and styles.css are injected automatically by the
  // manifest's content_scripts declaration (runs before this script).
  const C = window.ACBComponents;

  // ── Handoff prompt ──────────────────────────────────────────────
  const HANDOFF_PROMPT = (h) =>
    [
      `# Continue this task (AI Continuity Bridge handoff)`,
      ``,
      `Objective: ${h.objective}`,
      `Progress: ${h.progress_percent}% \u00b7 Files changed: ${h.files_changed} \u00b7 Errors remaining: ${h.errors_remaining}`,
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
      `For write_file \u2014 and ANY tool whose argument spans multiple lines \u2014 you MUST instead emit an acb block containing one JSON object:`,
      '```acb',
      '{"tool":"write_file","path":"src/example.ts","content":"<entire new file content>"}',
      '```',
      ``,
      `Each tool call is executed locally by the bridge and the real result will be returned here. Never claim to have read or written files without the tool results.`,
    ]
      .filter(Boolean)
      .join("\n");

  // ── Composer helpers ────────────────────────────────────────────
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

  // ── Tool capture ────────────────────────────────────────────────
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
    return null;
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
    const { tools, rest } = extractAcbTools(text);
    for (const tool of tools) sendTool(tool);
    for (const line of rest.split("\n")) {
      sendTool(parseToolLine(line.trim()));
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(observer._t);
    observer._t = setTimeout(scan, 800);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Root + status ───────────────────────────────────────────────
  let root = null;
  let statusPill = null;

  function ensureRoot() {
    if (!root) {
      root = document.createElement("div");
      root.id = "acb-root";
      root.className = "acb-root";
      document.body.appendChild(root);
    }
    return root;
  }

  function ensureStatusPill() {
    if (!statusPill && C) {
      statusPill = new C.ACBStatusPill();
      statusPill.mount(document.body);
      statusPill.setState("connecting");
    }
    return statusPill;
  }

  // ── Widget rendering ────────────────────────────────────────────
  const TARGET_LABEL = {
    claudeai: "Continue with Claude.ai",
    gemini: "Continue with Gemini",
    chatgpt: "Continue with ChatGPT",
  };

  function showHandoffCard(h) {
    const label = TARGET_LABEL[h.target] || TARGET_LABEL.chatgpt;
    const card = new C.ACBHandoffCard(h, label);
    card.onAction((action) => {
      if (action === "continue") {
        const inserted = insertIntoComposer(HANDOFF_PROMPT(h));
        if (inserted && h.auto) setTimeout(submitComposer, 300);
      }
    });
    card.mount(document.body);
    if (h.auto) {
      const inserted = insertIntoComposer(HANDOFF_PROMPT(h));
      if (inserted) setTimeout(submitComposer, 300);
      card.destroy();
    }
  }

  function showToolWidget(msg) {
    const root = ensureRoot();
    const r = msg.result;

    const toolName = (() => {
      if (msg.tool?.ReadFile) return "read_file";
      if (msg.tool?.WriteFile) return "write_file";
      if (msg.tool?.RunCommand) return "run_command";
      if (msg.tool?.ListDirectory) return "list_directory";
      if (msg.tool?.GitStatus != null) return "git_status";
      return "tool";
    })();

    if (r.pending) {
      const card = new C.ACBToolCard(msg.tool || {}, msg.id);
      card.onAction((action) => {
        chrome.runtime.sendMessage({
          type: "approve",
          id: msg.id,
          allow: action === "allow",
        });
      });
      card.mount(root);
      return;
    }

    if (toolName === "run_command") {
      const terminal = new C.ACBTerminal(
        msg.tool?.RunCommand?.command || "command",
        msg.id,
      );
      const output = r.ok ? (r.output ?? "") : (r.error ?? "");
      output.split("\n").forEach((line) => terminal.appendLine(line));
      terminal.finish(r.ok, null);
      terminal.onAction((action) => {
        if (action === "insert") insertIntoComposer(output);
      });
      terminal.mount(root);
      return;
    }

    const result = new C.ACBResultBlock(
      { ok: r.ok, output: r.ok ? r.output : r.error },
      toolName,
    );
    result.onAction((action) => {
      if (action === "insert") {
        const text = r.ok ? r.output : r.error;
        if (text) insertIntoComposer(text);
      }
    });
    result.mount(root);
  }

  // ── Message listener ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "handoff" && msg.payload) {
      showHandoffCard(msg.payload);
    }
    if (msg.type === "tool-result" && msg.result) {
      showToolWidget(msg);
    }
    // Status updates from background
    if (msg.type === "status") {
      ensureStatusPill();
      if (statusPill) {
        statusPill.setState(msg.connected ? "connected" : "disconnected");
      }
    }
  });
})();
