// AI Continuity Bridge — chatgpt.com content script v2.0.
// Premium dark-mode UI: status pill, tool cards, result blocks, terminal.
//
// The tool vocabulary — names, aliases, parsers, timeouts, prompt text —
// lives in tool-spec.js, shared with content-any.js and background.js.
// Only the ChatGPT-specific DOM handling belongs in this file.

(() => {
  "use strict";

  // A tab can end up with two copies of this script: the manifest injects
  // at document_idle, while the background injects programmatically when a
  // tabs.sendMessage fails during the page-load race (a tab still loading
  // looks identical to a tab with no content script). A second copy would
  // scan the same transcript with its own dedup set — every tool call sent
  // twice, executed twice. Re-injection must be a no-op.
  if (window.__ACB_CONTENT) return;
  window.__ACB_CONTENT = true;

  // tool-spec.js, ui-components.js and styles.css are injected automatically
  // by the manifest's content_scripts declaration (they run before this).
  const C = window.ACBComponents;
  const S = window.ACBToolSpec;

  // ── Handoff prompt ──────────────────────────────────────────────
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
      S.promptToolSection(),
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
    // Every insert path funnels through here, so one cap covers auto-insert,
    // both Insert buttons, the handoff prompt and the manifest button.
    text = S.capForComposer(text);
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
  const sentSigs = new Set();
  function sendTool(tool) {
    if (!tool) return;
    const sig = JSON.stringify(tool);
    if (sentSigs.has(sig)) return;
    sentSigs.add(sig);
    if (sentSigs.size > 200) sentSigs.delete(sentSigs.values().next().value);
    showWorkingStage(tool);
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
    // Tagged and fenced JSON blocks first; then one-line calls on what's left.
    const { tools, rest } = S.extractTools(text);
    for (const tool of tools) sendTool(tool);
    for (const line of rest.split("\n")) {
      sendTool(S.parseToolLine(line.trim()));
    }
  };

  // Mutations from our own dock would otherwise schedule a scan on every
  // entry mount and every composer insert.
  const OWN = "#acb-dock, .acb-handoff-overlay, .acb-toast";

  const observer = new MutationObserver((records) => {
    const relevant = records.some((r) => {
      const node = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      return !node || !node.closest(OWN);
    });
    if (!relevant) return;
    clearTimeout(observer._t);
    observer._t = setTimeout(scan, 800);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ── Dock (panel + timeline) ─────────────────────────────────────
  let dock = null;

  function ensureDock() {
    if ((!dock || !dock.el.isConnected) && C) {
      dock = new C.ACBDock();
      dock.mount(document.body);
      dock.setStatus("connecting");
      dock.onHistory(showHistory);
      // Pushed status only arrives on change; a fresh dock must ask for
      // the current state or it shows "connecting…" forever.
      chrome.runtime
        .sendMessage({ type: "get-status" })
        .then((s) => dock?.setStatus(s?.connected ? "connected" : "disconnected"))
        .catch(() => {});
    }
    return dock;
  }

  /** Open the dock's History view — past tool calls from the background's
   *  persistent log, the extension's counterpart of the desktop audit trail. */
  function showHistory() {
    const d = ensureDock();
    if (!d) return;
    d.panel.querySelector(".acb-history")?.remove();
    chrome.runtime
      .sendMessage({ type: "get-history" })
      .then((entries) => new C.ACBHistoryPanel(entries).mount(d.panel))
      .catch(() => {});
  }

  // ── Global close handler (event delegation — always works) ──────
  document.addEventListener("click", (e) => {
    const closeBtn = e.target.closest(".acb-close");
    if (!closeBtn) return;
    e.stopPropagation();
    e.preventDefault();
    // The History panel is a full-dock overlay, not a timeline widget,
    // but it closes through the same path.
    const widget = closeBtn.closest(".acb-widget, .acb-history");
    if (widget) {
      widget.setAttribute("data-state", "dismissed");
      setTimeout(() => widget.remove(), 200);
    }
  }, true);

  // ── Stage (dock footer line) ────────────────────────────────────
  const showWorkingStage = (tool) => ensureDock()?.setStage(S.stageLabel(tool), "working");
  const markStageDone = () => ensureDock()?.setStage("Finished ✓", "done");
  const markStageInserted = () => ensureDock()?.setStage("Inserted ✓", "done");
  const markStageFailed = () => ensureDock()?.setStage("Failed ✗", "error");
  const markStageAwait = () => ensureDock()?.setStage("Awaiting approval…", "working");

  // ── Widget rendering ────────────────────────────────────────────
  const TARGET_LABEL = {
    claudeai: "Continue with Claude.ai",
    gemini: "Continue with Gemini",
    grok: "Continue with Grok",
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
    const root = ensureDock()?.timeline;
    if (!root) return;

    // Handle v2 tool_result format
    if (msg.type === "tool_result") {
      const status = msg.status;
      const result = msg.result || {};
      const error = msg.error || {};
      const meta = msg.meta || {};

      if (status === "pending") {
        // Informational only: approval happens in the desktop app, whose
        // window no page script can reach. The final tool_result arrives
        // here once the desktop resolves it.
        markStageAwait();
        const toolObj = { name: meta.tool || "tool", arguments: meta };
        new C.ACBToolCard(toolObj, msg.id).mount(root);
        return;
      }

      if (status === "denied" || status === "timeout" || status === "error") {
        markStageFailed();
        const resultBlock = new C.ACBResultBlock(
          { ok: false, output: error.message || (status === "error" ? "Unknown error" : status) },
          meta.tool || "tool",
          { detail: meta.path || meta.command || meta.detail || "", errorCode: error.code || "" },
        );
        resultBlock.mount(root);
        return;
      }

      // status === "success"
      if (meta.tool === "run_command") {
        const terminal = new C.ACBTerminal(
          meta.command || "command",
          msg.id,
        );
        const output = result.output || "";
        terminal.setOutput(output);
        terminal.finish(true, meta.duration_ms ? `${meta.duration_ms}ms` : null);
        terminal.onAction((action) => {
          if (action === "insert") insertIntoComposer(output);
        });
        terminal.mount(root);
        // The web AI only sees what reaches the composer, so successful
        // command output is pasted automatically — the Insert button can
        // re-add it (or add it again after the user edits it away).
        if (output) insertIntoComposer(output);
        markStageInserted();
        return;
      }

      // Read-only results go straight back into the chat.
      if (S.isAutoInsert(meta.tool) && result.output) {
        insertIntoComposer(result.output);
        markStageInserted();
        return;
      }

      const resultBlock = new C.ACBResultBlock(
        { ok: true, output: result.output },
        meta.tool || "tool",
        { detail: meta.path || meta.command || meta.detail || "" },
      );
      resultBlock.onAction((action) => {
        if (action === "insert" && result.output) {
          insertIntoComposer(result.output);
        }
      });
      resultBlock.mount(root);
      markStageDone();
      return;
    }

    // Legacy v1: tool-result format
    const r = msg.result;
    const t = S.normalizeTool(msg.tool) || { name: "tool", args: {} };

    if (r.pending) {
      // Informational only — approval resolves in the desktop app.
      markStageAwait();
      new C.ACBToolCard(msg.tool || {}, msg.id).mount(root);
      return;
    }

    if (t.name === "run_command") {
      const terminal = new C.ACBTerminal(t.args.command || "command", msg.id);
      const output = r.ok ? (r.output ?? "") : (r.error ?? "");
      terminal.setOutput(output);
      terminal.finish(r.ok, null);
      terminal.onAction((action) => {
        if (action === "insert") insertIntoComposer(output);
      });
      terminal.mount(root);
      // Mirror the v2 path: paste successful output for the web AI.
      if (r.ok && output) insertIntoComposer(output);
      r.ok ? markStageInserted() : markStageFailed();
      return;
    }

    // Read-only results go straight back into the chat.
    if (r.ok && S.isAutoInsert(t.name) && r.output) {
      insertIntoComposer(r.output);
      markStageInserted();
      return;
    }

    const result = new C.ACBResultBlock(
      { ok: r.ok, output: r.ok ? r.output : r.error },
      t.name,
    );
    result.onAction((action) => {
      if (action === "insert") {
        const text = r.ok ? r.output : r.error;
        if (text) insertIntoComposer(text);
      }
    });
    result.mount(root);
    r.ok ? markStageDone() : markStageFailed();
  }

  // ── Message listener ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    console.log("[ACB content] message received:", msg.type);
    if (msg.type === "handoff" && msg.payload) {
      showHandoffCard(msg.payload);
    }
    if (msg.type === "handoff-error") {
      const el = document.createElement("div");
      el.className = "acb-toast";
      el.innerHTML = `<span class="acb-status-dot"></span><span class="acb-status-text">Handoff failed: ${C.escapeHtml(msg.error || "unknown error")}</span>`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 8000);
    }
    // Prime an already-open chat with the tool manifest (popup button).
    if (msg.type === "send-manifest") {
      const inserted = insertIntoComposer(S.promptToolSection());
      if (inserted) setTimeout(submitComposer, 300);
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
      ensureDock()?.setStatus(msg.connected ? "connected" : "disconnected");
    }
  });
})();
