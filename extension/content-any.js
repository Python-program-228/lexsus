// AI Continuity Bridge — content script v2.0 for claude.ai and gemini.google.com.
// Premium dark-mode UI: status pill, tool cards, result blocks, terminal.
//
// The tool vocabulary — names, aliases, parsers, timeouts, prompt text —
// lives in tool-spec.js, shared with content.js (chatgpt.com) and
// background.js. Only per-host DOM handling belongs in this file.

(() => {
  "use strict";

  const host = (() => {
    const h = location.hostname;
    if (h.includes("claude.ai")) return "claudeai";
    if (h.includes("gemini.google.com")) return "gemini";
    return "other";
  })();

  // tool-spec.js, ui-components.js and styles.css are injected automatically
  // by the manifest's content_scripts declaration (they run before this).
  const C = window.ACBComponents;
  const S = window.ACBToolSpec;

  // ── DOM selectors per host ──────────────────────────────────────
  const COMPS = {
    claudeai: 'div[contenteditable="true"]',
    gemini: 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"], div[contenteditable="true"]',
  };
  const SUBMIT = {
    claudeai: 'button[aria-label="Send message"], button[aria-label="Send"]',
    gemini: 'button[aria-label="Send message"], button[data-test-id="send-button"]',
  };
  const MESSAGES = {
    claudeai: ".font-claude-message",
    gemini: "model-response .markdown-content, .model-response-text, .markdown-content",
  };

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
    const sel = COMPS[host] || "div[contenteditable='true']";
    return (
      document.querySelector(sel) ||
      document.querySelector("textarea") ||
      document.querySelector("#prompt-textarea")
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
    const sel = SUBMIT[host];
    const btn = sel && document.querySelector(sel);
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

  // ── Scanning ────────────────────────────────────────────────────
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
    let source = null;
    const sel = MESSAGES[host];
    if (sel) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length > 0) source = nodes[nodes.length - 1].textContent;
    }
    if (source == null) source = document.body ? document.body.innerText.slice(-8000) : "";
    if (source === lastScanned) return;
    lastScanned = source;
    // Tagged and fenced JSON blocks first; then one-line calls on what's left.
    const { tools, rest } = S.extractTools(source);
    for (const tool of tools) sendTool(tool);
    for (const line of rest.split("\n")) {
      sendTool(S.parseToolLine(line.trim()));
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(observer._t);
    observer._t = setTimeout(scan, 900);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

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

  // ── Stage indicator (live tool progress) ────────────────────────
  let stage = null;
  function ensureStage() {
    if ((!stage || !stage.el.isConnected) && C) {
      stage = new C.ACBStageIndicator();
      stage.mount(document.body);
    }
    return stage;
  }
  const showWorkingStage = (tool) => ensureStage()?.setStage(S.stageLabel(tool), "working");
  const markStageDone = () => ensureStage()?.setStage("Finished ✓", "done");
  const markStageInserted = () => ensureStage()?.setStage("Inserted ✓", "done");
  const markStageFailed = () => ensureStage()?.setStage("Failed ✗", "error");
  const markStageAwait = () => ensureStage()?.setStage("Awaiting approval…", "working");

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
    const oldBadge = r.querySelector(".acb-stack-more");
    if (oldBadge) oldBadge.remove();
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
        if (inserted && h.auto) setTimeout(submitComposer, 400);
      }
    });
    card.mount(document.body);
    if (h.auto) {
      const inserted = insertIntoComposer(HANDOFF_PROMPT(h));
      if (inserted) setTimeout(submitComposer, 400);
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
        markStageAwait();
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

      if (status === "denied" || status === "timeout" || status === "error") {
        markStageFailed();
        const resultBlock = new C.ACBResultBlock(
          { ok: false, output: error.message || (status === "error" ? "Unknown error" : status) },
          meta.tool || "tool",
          { detail: meta.path || meta.command || meta.detail || "", errorCode: error.code || "" },
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
        markStageDone();
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
      limitVisibleWidgets();
      markStageDone();
      return;
    }

    // Legacy v1: tool-result format
    const r = msg.result;
    const t = S.normalizeTool(msg.tool) || { name: "tool", args: {} };

    if (r.pending) {
      const card = new C.ACBToolCard(msg.tool || {}, msg.id);
      markStageAwait();
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

    if (t.name === "run_command") {
      const terminal = new C.ACBTerminal(t.args.command || "command", msg.id);
      const output = r.ok ? (r.output ?? "") : (r.error ?? "");
      output.split("\n").forEach((line) => terminal.appendLine(line));
      terminal.finish(r.ok, null);
      terminal.onAction((action) => {
        if (action === "insert") insertIntoComposer(output);
      });
      terminal.mount(root);
      limitVisibleWidgets();
      r.ok ? markStageDone() : markStageFailed();
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
    limitVisibleWidgets();
    r.ok ? markStageDone() : markStageFailed();
  }

  // ── Message listener ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "handoff" && msg.payload) showHandoffCard(msg.payload);
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
      if (inserted) setTimeout(submitComposer, 400);
    }
    // v2: tool_result
    if (msg.type === "tool_result") showToolWidget(msg);
    // v1: tool-result (legacy)
    if (msg.type === "tool-result" && msg.result) showToolWidget(msg);
    if (msg.type === "status") {
      ensureStatusPill();
      if (statusPill) {
        statusPill.setState(msg.connected ? "connected" : "disconnected");
      }
    }
  });
})();
