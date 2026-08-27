/* AI Continuity Bridge — UI Component Library v2.1
   Reusable, lightweight DOM components for the extension.
   iOS-style stacked notifications with close + expand/collapse. */

(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (children) children.forEach((c) => e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return e;
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

  const CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  function createCloseBtn() {
    const btn = el("button", { class: "acb-close", title: "Dismiss" });
    btn.innerHTML = CLOSE_SVG;
    return btn;
  }

  // ── Status Pill ──────────────────────────────────────────────────
  class ACBStatusPill {
    constructor() {
      this.latency = 0;
      this.connectedAt = Date.now();
      this.el = el("div", { class: "acb-status-pill", "data-state": "connecting" }, []);
      this.dot = el("span", { class: "acb-status-dot" });
      this.text = el("span", { class: "acb-status-text" }, ["Local bridge \u2022 connecting"]);
      this.el.appendChild(this.dot);
      this.el.appendChild(this.text);
      this._tick = setInterval(() => this._updateLatency(), 2000);
    }
    setState(state) {
      this.el.setAttribute("data-state", state);
      const label =
        state === "connected" ? "connected" : state === "connecting" ? "connecting\u2026" : "disconnected";
      this.text.textContent = `Local bridge \u2022 ${label}\u2022 ${this.latency}s`;
      if (state === "connected") this.connectedAt = Date.now();
    }
    setText(text) {
      this.text.textContent = text;
    }
    _updateLatency() {
      this.latency = ((Date.now() - this.connectedAt) / 1000).toFixed(1);
      const state = this.el.getAttribute("data-state");
      if (state === "connected") {
        const label = "connected";
        this.text.textContent = `Local bridge \u2022 ${label}\u2022 ${this.latency}s`;
      }
    }
    mount(root) {
      root.appendChild(this.el);
      return this;
    }
    destroy() {
      clearInterval(this._tick);
      this.el.remove();
    }
  }

  // ── Stage Indicator (live tool progress) ────────────────────────
  const STAGE_SPINNER_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  const STAGE_CHECK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const STAGE_X_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  class ACBStageIndicator {
    constructor() {
      this.el = el("div", { class: "acb-stage", "data-state": "working" });
      this.icon = el("span", { class: "acb-stage-icon" });
      this.text = el("span", { class: "acb-stage-text" });
      this.el.appendChild(this.icon);
      this.el.appendChild(this.text);
      this._clearTimer = null;
    }
    setStage(text, state) {
      if (this._clearTimer) {
        clearTimeout(this._clearTimer);
        this._clearTimer = null;
      }
      this.el.setAttribute("data-state", state || "working");
      this.icon.innerHTML =
        state === "done" ? STAGE_CHECK_SVG : state === "error" ? STAGE_X_SVG : STAGE_SPINNER_SVG;
      this.text.textContent = text;
      if (state === "done" || state === "error") {
        this._clearTimer = setTimeout(() => this.clear(), 2500);
      }
    }
    clear() {
      if (this._clearTimer) {
        clearTimeout(this._clearTimer);
        this._clearTimer = null;
      }
      this.el.remove();
    }
    mount(root) {
      root.appendChild(this.el);
      return this;
    }
    destroy() {
      this.clear();
    }
  }

  // ── Tool Card (approval pending) ─────────────────────────────────
  class ACBToolCard {
    constructor(tool, msgId) {
      this.tool = tool;
      this.msgId = msgId;
      this.el = el("div", {
        class: "acb-widget acb-tool-card",
        "data-state": "pending",
        "data-tool": this._toolName(),
        "data-expanded": "true",
      });
      this._build();
    }
    _toolName() {
      if (this.tool.ReadFile) return "read_file";
      if (this.tool.WriteFile) return "write_file";
      if (this.tool.RunCommand) return "run_command";
      if (this.tool.ListDirectory) return "list_directory";
      if (this.tool.GitStatus != null) return "git_status";
      return "unknown";
    }
    _toolDetail() {
      const t = this.tool;
      if (t.ReadFile) return t.ReadFile.path;
      if (t.WriteFile) return t.WriteFile.path;
      if (t.RunCommand) return t.RunCommand.command;
      if (t.ListDirectory) return t.ListDirectory.path;
      if (t.GitStatus != null) return "(status)";
      return "";
    }
    _toolIcon() {
      const icons = {
        read_file:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
        write_file:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        run_command:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        list_directory:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
        git_status:
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>',
      };
      return icons[this._toolName()] || "";
    }
    _build() {
      const name = this._toolName();
      const detail = this._toolDetail();
      const iconHtml = `<span class="acb-tool-badge-icon">${this._toolIcon()}</span>`;

      // Header — click to expand/collapse, close button
      const header = el("div", { class: "acb-widget-header" });
      header.innerHTML = `
        <span class="acb-tool-badge ${name}">${iconHtml}${name}</span>
        <span class="acb-tool-path">${escapeHtml(detail)}</span>
      `;
      this._closeBtn = createCloseBtn();
      header.appendChild(this._closeBtn);
      this.el.appendChild(header);

      // Body — preview + actions
      const body = el("div", { class: "acb-widget-body" });

      if (this.tool.WriteFile) {
        const preview = this.tool.WriteFile.content || "";
        const previewEl = el("div", { class: "acb-tool-preview" }, []);
        previewEl.textContent = preview;
        body.appendChild(previewEl);
      } else if (this.tool.RunCommand) {
        const cmdEl = el("div", { class: "acb-tool-preview" });
        cmdEl.innerHTML = `<span style="color:var(--acb-text-dim)">$</span> ${escapeHtml(detail)}`;
        body.appendChild(cmdEl);
      }

      const actions = el("div", { class: "acb-tool-actions" });
      actions.innerHTML = `
        <button class="acb-btn acb-btn--deny" data-action="deny">Deny</button>
        <button class="acb-btn acb-btn--allow" data-action="allow">Allow</button>
      `;
      body.appendChild(actions);
      this.el.appendChild(body);
    }
    onAction(cb) {
      // Close button
      this._closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.el.setAttribute("data-state", "dismissed");
        setTimeout(() => this.el.remove(), 200);
        cb("dismiss");
      });
      // Expand/collapse on header click (not close button)
      this.el.querySelector(".acb-widget-header").addEventListener("click", (e) => {
        if (e.target.closest(".acb-close")) return;
        const expanded = this.el.getAttribute("data-expanded") === "true";
        this.el.setAttribute("data-expanded", expanded ? "false" : "true");
      });
      // Allow/Deny buttons
      this.el.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        const action = btn.getAttribute("data-action");
        if (action === "allow") {
          this.el.setAttribute("data-state", "approved");
          setTimeout(() => this.el.remove(), 120);
        } else if (action === "deny") {
          this.el.setAttribute("data-state", "denied");
          setTimeout(() => this.el.remove(), 100);
        }
        cb(action);
      });
    }
    mount(root) {
      root.appendChild(this.el);
      return this;
    }
  }

  // ── Result Block ─────────────────────────────────────────────────
  class ACBResultBlock {
    constructor(result, toolName) {
      this.result = result;
      this.toolName = toolName;
      this.el = el("div", {
        class: "acb-widget acb-result-block",
        "data-state": result.ok ? "success" : "error",
        "data-expanded": "false",
      });
      this._build();
    }
    _build() {
      const ok = this.result.ok;
      const output = this.result.output || this.result.error || "";

      // Header — click to expand/collapse, close button
      const header = el("div", { class: "acb-widget-header" });
      const checkSvg = ok
        ? '<svg class="acb-result-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l2.5 2.5L16 9.5"/></svg>'
        : '<svg class="acb-result-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
      const label = ok ? "Done" : "Failed";
      header.innerHTML = `${checkSvg}<span>${label}</span><span class="acb-result-meta">${this.toolName}</span>`;
      this._closeBtn = createCloseBtn();
      header.appendChild(this._closeBtn);
      this.el.appendChild(header);

      // Body — content + actions
      const body = el("div", { class: "acb-widget-body" });

      const content = el("div", { class: "acb-result-content" });
      const pre = el("pre");
      const code = el("code");
      code.textContent = output;
      pre.appendChild(code);
      content.appendChild(pre);
      body.appendChild(content);

      const actions = el("div", { class: "acb-result-actions" });
      actions.innerHTML = `<button class="acb-btn acb-btn--ghost acb-btn--sm" data-action="insert">Insert into chat</button>`;
      body.appendChild(actions);
      this.el.appendChild(body);
    }
    onAction(cb) {
      // Close button
      this._closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.el.setAttribute("data-state", "dismissed");
        setTimeout(() => this.el.remove(), 200);
        cb("dismiss");
      });
      // Expand/collapse on header click
      this.el.querySelector(".acb-widget-header").addEventListener("click", (e) => {
        if (e.target.closest(".acb-close")) return;
        const expanded = this.el.getAttribute("data-expanded") === "true";
        this.el.setAttribute("data-expanded", expanded ? "false" : "true");
      });
      // Insert button
      this.el.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (btn) cb(btn.getAttribute("data-action"));
      });
    }
    mount(root) {
      root.appendChild(this.el);
      return this;
    }
  }

  // ── Terminal Stream ──────────────────────────────────────────────
  class ACBTerminal {
    constructor(command, msgId) {
      this.command = command;
      this.msgId = msgId;
      this.el = el("div", {
        class: "acb-widget acb-terminal",
        "data-expanded": "true",
      });
      this._build();
    }
    _build() {
      // Header — click to expand/collapse, close button
      this.header = el("div", { class: "acb-widget-header" });
      const headerInner = el("div", { style: "display:flex;align-items:center;gap:8px;flex:1;min-width:0;" });
      headerInner.innerHTML = `
        <span class="acb-terminal-prompt">$ ${escapeHtml(this.command)}</span>
        <span class="acb-terminal-status running">Running\u2026</span>
      `;
      this.header.appendChild(headerInner);
      this._closeBtn = createCloseBtn();
      this.header.appendChild(this._closeBtn);
      this.el.appendChild(this.header);

      // Body
      const body = el("div", { class: "acb-widget-body" });

      this.output = el("div", { class: "acb-terminal-output" });
      body.appendChild(this.output);

      this.footer = el("div", { class: "acb-terminal-footer" }, ["Waiting for output\u2026"]);
      body.appendChild(this.footer);
      this.el.appendChild(body);
    }
    appendLine(text) {
      this.output.textContent += text + "\n";
      this.output.scrollTop = this.output.scrollHeight;
    }
    finish(ok, elapsed) {
      const status = this.header.querySelector(".acb-terminal-status");
      status.className = `acb-terminal-status ${ok ? "done" : "error"}`;
      status.textContent = ok ? "Done" : "Failed";
      this.footer.textContent = `Exit code: ${ok ? "0" : "1"} \u2022 ${elapsed || "?"}`;
    }
    onAction(cb) {
      // Close button
      this._closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.el.setAttribute("data-state", "dismissed");
        setTimeout(() => this.el.remove(), 200);
        cb("dismiss");
      });
      // Expand/collapse on header click
      this.header.addEventListener("click", (e) => {
        if (e.target.closest(".acb-close")) return;
        const expanded = this.el.getAttribute("data-expanded") === "true";
        this.el.setAttribute("data-expanded", expanded ? "false" : "true");
      });
      // Insert button
      this.el.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (btn) cb(btn.getAttribute("data-action"));
      });
    }
    mount(root) {
      root.appendChild(this.el);
      return this;
    }
  }

  // ── Handoff Card ─────────────────────────────────────────────────
  class ACBHandoffCard {
    constructor(handoff, targetLabel) {
      this.handoff = handoff;
      this.targetLabel = targetLabel;
      this.overlay = el("div", { class: "acb-handoff-overlay" });
      this._build();
    }
    _build() {
      const card = el("div", { class: "acb-handoff-card" });
      const svg =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';

      card.innerHTML = `
        <h3>${svg} Bridge handoff ready</h3>
        <div class="acb-handoff-objective">${escapeHtml(this.handoff.objective)}</div>
        <div class="acb-handoff-stats">
          <span class="acb-handoff-stat progress"><b>${this.handoff.progress_percent}%</b> progress</span>
          <span class="acb-handoff-stat"><b>${this.handoff.files_changed}</b> files changed</span>
          <span class="acb-handoff-stat errors"><b>${this.handoff.errors_remaining}</b> errors</span>
        </div>
        ${this.handoff.next_step ? `<div class="acb-handoff-next">Next: ${escapeHtml(this.handoff.next_step)}</div>` : ""}
        <div class="acb-handoff-actions">
          <button class="acb-btn acb-btn--deny" data-action="dismiss">Dismiss</button>
          <button class="acb-btn acb-btn--allow" data-action="continue">${this.targetLabel}</button>
        </div>
      `;
      this.overlay.appendChild(card);
      this.card = card;
    }
    onAction(cb) {
      this.overlay.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (btn) {
          cb(btn.getAttribute("data-action"));
          this.destroy();
        }
      });
      this.overlay.addEventListener("click", (e) => {
        if (e.target === this.overlay) {
          this.destroy();
        }
      });
    }
    mount(root) {
      root.appendChild(this.overlay);
      return this;
    }
    destroy() {
      this.overlay.remove();
    }
  }

  // ── Exports ──────────────────────────────────────────────────────
  window.ACBComponents = {
    ACBStatusPill,
    ACBStageIndicator,
    ACBToolCard,
    ACBResultBlock,
    ACBTerminal,
    ACBHandoffCard,
    escapeHtml,
  };
})();
