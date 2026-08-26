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

  // ── Auto-insert & toast ─────────────────────────────────────────
  const AUTO_INSERT_TOOLS = new Set(["read_file", "list_directory", "git_status"]);

  function showToast(text) {
    const t = document.createElement("div");
    t.className = "acb-status-pill";
    t.setAttribute("data-state", "connected");
    t.innerHTML = `<span class="acb-status-dot" style="background:#10a37f"></span><span class="acb-status-text">${C.escapeHtml(text)}</span>`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2000);
  }

  // ── Tool capture (v2: supports <acb_tool> tags, fenced blocks, function calls) ──

  // Priority 1: <acb_tool>...</acb_tool> tags (highest reliability)
  const ACB_TAG_RE = /<acb_tool>([\s\S]*?)<\/acb_tool>/gi;

  // Priority 2: Fenced JSON blocks (```acb or ```json)
  const FENCED_RE = /```(?:acb|json)\s*\n([\s\S]*?)```/gi;

  // Priority 3: Function-call syntax
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

  // Priority 4: Inline JSON scanning (fallback)
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
    const args = obj.arguments || {};
    switch (name) {
      case "read_file":
        return typeof (args.path || obj.path) === "string"
          ? { name: "read_file", arguments: { path: args.path || obj.path } }
          : null;
      case "write_file":
        return typeof (args.path || obj.path) === "string"
          ? {
              name: "write_file",
              arguments: {
                path: args.path || obj.path,
                content: String(args.content || obj.content || ""),
              },
            }
          : null;
      case "run_command":
        return typeof (args.command || obj.command) === "string"
          ? { name: "run_command", arguments: { command: args.command || obj.command } }
          : null;
      case "list_directory":
        return typeof (args.path || obj.path) === "string"
          ? { name: "list_directory", arguments: { path: args.path || obj.path } }
          : null;
      case "git_status":
        return { name: "git_status", arguments: {} };
      default:
        return null;
    }
  }

  // Extract tools from <acb_tool> and fenced blocks. Returns extracted
  // tools plus the text with those blocks blanked out.
  function extractAcbTools(text) {
    const tools = [];
    const blanks = [];

    // Priority 1: <acb_tool> tags
    ACB_TAG_RE.lastIndex = 0;
    let m;
    while ((m = ACB_TAG_RE.exec(text)) !== null) {
      const tool = parseJsonBlock(m[1]);
      if (tool) {
        tools.push(tool);
        blanks.push([m.index, m.index + m[0].length]);
      }
    }

    // Priority 2: Fenced blocks
    FENCED_RE.lastIndex = 0;
    while ((m = FENCED_RE.exec(text)) !== null) {
      // Skip if already captured by <acb_tool>
      if (blanks.some(([s, e]) => m.index >= s && m.index < e)) continue;
      const tool = parseJsonBlock(m[1]);
      if (tool) {
        tools.push(tool);
        blanks.push([m.index, m.index + m[0].length]);
      }
    }

    // Priority 4: Inline JSON scanning (only if not in a fenced/tagged block)
    TOOL_KEY_RE.lastIndex = 0;
    let k;
    while ((k = TOOL_KEY_RE.exec(text)) !== null) {
      // Skip if inside a fenced/tagged block
      if (blanks.some(([s, e]) => k.index >= s && k.index < e)) continue;
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
          return { name: "read_file", arguments: { path: m[1] } };
        case "WriteFile":
          return {
            name: "write_file",
            arguments: { path: m[1], content: m[2] },
          };
        case "RunCommand":
          return { name: "run_command", arguments: { command: m[1] } };
        case "ListDirectory":
          return { name: "list_directory", arguments: { path: m[1] } };
        case "GitStatus":
          return { name: "git_status", arguments: {} };
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
    // Priority 3: function-call syntax on remaining text
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

  // ── Global close handler (event delegation — always works) ──────
  document.addEventListener("click", (e) => {
    const closeBtn = e.target.closest(".acb-close");
    if (!closeBtn) return;
    e.stopPropagation();
    e.preventDefault();
    const widget = closeBtn.closest(".acb-widget");
    if (widget) {
      widget.setAttribute("data-state", "dismissed");
      setTimeout(() => widget.remove(), 200);
    } else {
      closeBtn.closest(".acb-status-pill")?.remove();
    }
  }, true);

  function ensureStatusPill() {
    if (!statusPill && C) {
      statusPill = new C.ACBStatusPill();
      statusPill.mount(document.body);
      statusPill.setState("connecting");
    }
    return statusPill;
  }

  // ── Stacked widget management (iOS-style) ───────────────────────
  const MAX_VISIBLE = 3;

  function limitVisibleWidgets() {
    const r = ensureRoot();
    const widgets = r.querySelectorAll(".acb-widget");
    widgets.forEach((w, i) => {
      if (i < widgets.length - MAX_VISIBLE) {
        w.setAttribute("data-visible", "false");
      } else {
        w.removeAttribute("data-visible");
      }
    });
    // Remove old "more" badge if any
    const oldBadge = r.querySelector(".acb-stack-more");
    if (oldBadge) oldBadge.remove();
    // Add "N more" badge if hidden widgets exist
    const hidden = r.querySelectorAll('[data-visible="false"]');
    if (hidden.length > 0) {
      const badge = document.createElement("div");
      badge.className = "acb-stack-more";
      badge.textContent = `+${hidden.length} more`;
      badge.addEventListener("click", () => {
        hidden.forEach((w) => {
          w.setAttribute("data-visible", "true");
          w.setAttribute("data-expanded", "false");
        });
        badge.remove();
      });
      r.appendChild(badge);
    }
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

    // Handle v2 tool_result format
    if (msg.type === "tool_result") {
      const status = msg.status;
      const result = msg.result || {};
      const error = msg.error || {};
      const meta = msg.meta || {};

      if (status === "pending") {
        // Show tool card with Allow/Deny
        const toolObj = { name: meta.tool || "tool", arguments: meta };
        const card = new C.ACBToolCard(toolObj, msg.id);
        card.onAction((action) => {
          chrome.runtime.sendMessage({
            type: "approve",
            id: msg.id,
            allow: action === "allow",
          });
        });
        card.mount(root);
        limitVisibleWidgets();
        return;
      }

      if (status === "denied" || status === "timeout") {
        // Show error block
        const resultBlock = new C.ACBResultBlock(
          { ok: false, output: error.message || status },
          meta.tool || "tool",
        );
        resultBlock.mount(root);
        limitVisibleWidgets();
        return;
      }

      if (status === "error") {
        // Show error block
        const resultBlock = new C.ACBResultBlock(
          { ok: false, output: error.message || "Unknown error" },
          meta.tool || "tool",
        );
        resultBlock.mount(root);
        limitVisibleWidgets();
        return;
      }

      // status === "success"
      if (meta.tool === "run_command") {
        const terminal = new C.ACBTerminal(
          meta.command || "command",
          msg.id,
        );
        const output = result.output || "";
        output.split("\n").forEach((line) => terminal.appendLine(line));
        terminal.finish(true, meta.duration_ms ? `${meta.duration_ms}ms` : null);
        terminal.onAction((action) => {
          if (action === "insert") insertIntoComposer(output);
        });
        terminal.mount(root);
        limitVisibleWidgets();
        return;
      }

      // Auto-insert read-only tools (read_file, list_directory, git_status)
      if (AUTO_INSERT_TOOLS.has(meta.tool) && result.output) {
        insertIntoComposer(result.output);
        showToast(`${meta.tool} result inserted`);
        return;
      }

      const resultBlock = new C.ACBResultBlock(
        { ok: true, output: result.output },
        meta.tool || "tool",
      );
      resultBlock.onAction((action) => {
        if (action === "insert" && result.output) {
          insertIntoComposer(result.output);
        }
      });
      resultBlock.mount(root);
      limitVisibleWidgets();
      return;
    }

    // Legacy v1: tool-result format
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
      limitVisibleWidgets();
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
      limitVisibleWidgets();
      return;
    }

    // Auto-insert read-only tools (read_file, list_directory, git_status)
    if (r.ok && AUTO_INSERT_TOOLS.has(toolName) && r.output) {
      insertIntoComposer(r.output);
      showToast(`${toolName} result inserted`);
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
    limitVisibleWidgets();
  }

  // ── Message listener ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    console.log("[ACB content] message received:", msg.type);
    if (msg.type === "handoff" && msg.payload) {
      showHandoffCard(msg.payload);
    }
    if (msg.type === "handoff-error") {
      const el = document.createElement("div");
      el.className = "acb-status-pill";
      el.setAttribute("data-state", "error");
      el.innerHTML = `<span class="acb-status-dot" style="background:#dc2626"></span><span class="acb-status-text">Handoff failed: ${C.escapeHtml(msg.error || "unknown error")}</span>`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 8000);
    }
    // v2: tool_result
    if (msg.type === "tool_result") {
      showToolWidget(msg);
    }
    // v1: tool-result (legacy)
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
