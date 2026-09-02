// AI Continuity Bridge — shared content-script core (Agent Runtime, Phase 1).
//
// Everything that used to be duplicated between content.js (chatgpt.com)
// and content-any.js (claude.ai/gemini/grok) lives here once. Host-specific
// DOM handling comes from chat-adapters.js; the tool vocabulary from
// tool-spec.js; widgets from ui-components.js.
//
// New in Phase 1:
//   * controlled auto-submit — a successful auto-insert result is followed
//     by ONE composer submit per result id, closing the feedback loop (the
//     AI no longer waits for the user to press Enter);
//   * tool_stream frames — live command output streams into the terminal
//     widget while the command runs;
//   * MCP tools — registered dynamically from the app's `mcp_tools` frame.

(() => {
  "use strict";

  function boot(forcedHost) {
    // Re-injection must be a no-op (manifest injects at document_idle, the
    // background re-injects on a tabs.sendMessage race).
    if (window.__ACB_CONTENT) return;
    window.__ACB_CONTENT = true;

    const C = window.ACBComponents;
    const S = window.ACBToolSpec;
    const adapter = forcedHost
      ? window.ACBAdapters.byHost(forcedHost)
      : window.ACBAdapters.detect();
    const host = adapter.host;

    // ── Handoff prompt ────────────────────────────────────────────
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

    // ── Composer helpers (via the adapter) ────────────────────────
    function findComposer() {
      return window.ACBAdapters.findComposer(adapter);
    }

    function insertIntoComposer(text) {
      const el = findComposer();
      if (!el) return false;
      // Every insert path funnels through here, so one cap covers
      // auto-insert, both Insert buttons, the handoff prompt and the
      // manifest button.
      return adapter.insertText(el, S.capForComposer(text));
    }

    function submitComposer() {
      return adapter.submit();
    }

    // ── Controlled auto-submit ────────────────────────────────────
    //
    // The missing half of the feedback loop: a tool result inserted into
    // the composer used to sit there until the user pressed Enter. Now a
    // successful auto-insert is submitted once — guarded by result id so
    // a duplicate/retried frame can never double-submit, and only for
    // auto-insert (read-only) tools, whose output is meant for the AI.
    const submittedIds = new Set();
    function submitOnce(id) {
      if (!id || submittedIds.has(id)) return;
      submittedIds.add(id);
      if (submittedIds.size > 500) {
        submittedIds.delete(submittedIds.values().next().value);
      }
      setTimeout(() => submitComposer(), 400);
    }

    // ── Scanning ──────────────────────────────────────────────────
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
      // The generic adapter has no message selector: scanning stays off
      // on unknown hosts rather than misfiring on page chrome.
      const sel = adapter.messageSelector;
      if (!sel) return;
      const nodes = document.querySelectorAll(sel);
      if (nodes.length === 0) return;
      // No `document.body.innerText` fallback: it read the composer, so an
      // auto-inserted result re-triggered itself before being sent.
      const source = nodes[nodes.length - 1].textContent;
      if (source == null || source === lastScanned) return;
      lastScanned = source;
      // Tagged and fenced JSON blocks first; then one-line calls.
      const { tools, rest } = S.extractTools(source);
      for (const tool of tools) sendTool(tool);
      for (const line of rest.split("\n")) {
        sendTool(S.parseToolLine(line.trim()));
      }
    };

    // Mutations from our own dock would otherwise schedule a scan on
    // every entry mount and every composer insert.
    const OWN = "#acb-dock, .acb-handoff-overlay, .acb-toast";

    const observer = new MutationObserver((records) => {
      const relevant = records.some((r) => {
        const node = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        return !node || !node.closest(OWN);
      });
      if (!relevant) return;
      clearTimeout(observer._t);
      observer._t = setTimeout(scan, 900);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // ── Dock (panel + timeline) ───────────────────────────────────
    let dock = null;

    function ensureDock() {
      if ((!dock || !dock.el.isConnected) && C) {
        dock = new C.ACBDock();
        dock.mount(document.body);
        dock.setStatus("connecting");
        dock.onHistory(showHistory);
        chrome.runtime
          .sendMessage({ type: "get-status" })
          .then((s) => dock?.setStatus(s?.connected ? "connected" : "disconnected"))
          .catch(() => {});
      }
      return dock;
    }

    function showHistory() {
      const d = ensureDock();
      if (!d) return;
      d.panel.querySelector(".acb-history")?.remove();
      chrome.runtime
        .sendMessage({ type: "get-history" })
        .then((entries) => new C.ACBHistoryPanel(entries).mount(d.panel))
        .catch(() => {});
    }

    // ── Global close handler (event delegation) ───────────────────
    document.addEventListener(
      "click",
      (e) => {
        const closeBtn = e.target.closest(".acb-close");
        if (!closeBtn) return;
        e.stopPropagation();
        e.preventDefault();
        const widget = closeBtn.closest(".acb-widget, .acb-history");
        if (widget) {
          widget.setAttribute("data-state", "dismissed");
          setTimeout(() => widget.remove(), 200);
        }
      },
      true,
    );

    // ── Stage (dock footer line) ──────────────────────────────────
    const showWorkingStage = (tool) =>
      ensureDock()?.setStage(S.stageLabel(tool), "working");
    const markStageDone = () => ensureDock()?.setStage("Finished ✓", "done");
    const markStageInserted = () => ensureDock()?.setStage("Inserted ✓", "done");
    const markStageFailed = () => ensureDock()?.setStage("Failed ✗", "error");
    const markStageAwait = () => ensureDock()?.setStage("Awaiting approval…", "working");

    // ── Widget rendering ──────────────────────────────────────────
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

    // Live terminals for tool_stream frames, keyed by request id.
    const liveTerminals = new Map();

    function handleStream(msg) {
      const root = ensureDock()?.timeline;
      if (!root) return;
      if (msg.kind === "start") {
        const terminal = new C.ACBTerminal(msg.command || "command", msg.id);
        terminal.mount(root);
        liveTerminals.set(msg.id, terminal);
        return;
      }
      const terminal = liveTerminals.get(msg.id);
      if (!terminal) return;
      if (msg.kind === "output" && msg.data) {
        terminal.appendOutput ? terminal.appendOutput(msg.data) : terminal.setOutput((terminal._out || "") + msg.data);
        terminal._out = (terminal._out || "") + msg.data;
      }
      if (msg.kind === "exit") {
        terminal.finish(msg.code === 0, null);
        liveTerminals.delete(msg.id);
      }
    }

    function showToolWidget(msg) {
      const root = ensureDock()?.timeline;
      if (!root) return;

      // v2 tool_result format
      if (msg.type === "tool_result") {
        const status = msg.status;
        const result = msg.result || {};
        const error = msg.error || {};
        const meta = msg.meta || {};

        if (status === "pending") {
          // Informational only: approval happens in the desktop app. The
          // final tool_result arrives here once the desktop resolves it.
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
          const existing = liveTerminals.get(msg.id);
          const terminal = existing || new C.ACBTerminal(meta.command || "command", msg.id);
          const output = result.output || "";
          terminal.setOutput(output);
          terminal.finish(true, meta.duration_ms ? `${meta.duration_ms}ms` : null);
          terminal.onAction((action) => {
            if (action === "insert") insertIntoComposer(output);
          });
          if (!existing) terminal.mount(root);
          liveTerminals.delete(msg.id);
          if (output) insertIntoComposer(output);
          submitOnce(msg.id);
          markStageInserted();
          return;
        }

        // Read-only results go straight back into the chat — and now the
        // composer is submitted too, so the AI actually sees them.
        if (S.isAutoInsert(meta.tool) && result.output) {
          insertIntoComposer(result.output);
          submitOnce(msg.id);
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
        if (r.ok && output) insertIntoComposer(output);
        if (r.ok) submitOnce(msg.id);
        r.ok ? markStageInserted() : markStageFailed();
        return;
      }

      if (r.ok && S.isAutoInsert(t.name) && r.output) {
        insertIntoComposer(r.output);
        submitOnce(msg.id);
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

    // ── MCP tools: ask the app for its live tool list ─────────────
    function refreshMcpTools() {
      chrome.runtime
        .sendMessage({ type: "get-mcp-tools" })
        .then((tools) => {
          if (Array.isArray(tools)) S.registerMcpTools(tools);
        })
        .catch(() => {});
    }

    // ── Message listener ──────────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "handoff" && msg.payload) showHandoffCard(msg.payload);
      if (msg.type === "handoff-error") {
        const el = document.createElement("div");
        el.className = "acb-toast";
        el.innerHTML = `<span class="acb-status-dot"></span><span class="acb-status-text">Handoff failed: ${C.escapeHtml(msg.error || "unknown error")}</span>`;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 8000);
      }
      if (msg.type === "send-manifest") {
        const inserted = insertIntoComposer(S.promptToolSection());
        if (inserted) setTimeout(submitComposer, 400);
      }
      if (msg.type === "tool_result") showToolWidget(msg);
      if (msg.type === "tool-result" && msg.result) showToolWidget(msg);
      if (msg.type === "tool_stream") handleStream(msg);
      if (msg.type === "mcp_tools" && Array.isArray(msg.tools)) {
        S.registerMcpTools(msg.tools);
      }
      if (msg.type === "status") {
        ensureDock()?.setStatus(msg.connected ? "connected" : "disconnected");
        if (msg.connected) refreshMcpTools();
      }
    });

    refreshMcpTools();
  }

  globalThis.ACBContentCore = { boot };
})();
