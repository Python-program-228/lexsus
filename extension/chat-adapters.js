// AI Continuity Bridge — chat adapters (Agent Runtime, Phase 1).
//
// One adapter per supported web AI. An adapter owns *everything* that is
// host-specific: how to find the composer, how to insert text, how to
// submit, and how to read the assistant's messages. The shared logic
// (scanning, dedup, widgets, feedback loop) lives in content-core.js and
// talks to the host only through this interface:
//
//   adapter = {
//     host: "chatgpt",                  // canonical host key
//     composerSelector: "...",          // candidates, most specific first
//     submitSelector: "..." | null,     // send button; null → Enter fallback
//     messageSelector: "...",           // assistant message nodes
//     insertText(el, text),             // default: shared implementation
//     submit(),                         // default: click button, else Enter
//     isReady(),                        // default: composer exists
//   }
//
// Adding a new host = adding one entry to ADAPTERS. No other file changes.
//
// Exposed as `globalThis.ACBAdapters`.

(() => {
  "use strict";

  // ── Shared DOM primitives ───────────────────────────────────────

  function findComposer(adapter) {
    return (
      document.querySelector(adapter.composerSelector) ||
      document.querySelector("textarea") ||
      document.querySelector("#prompt-textarea")
    );
  }

  // The ProseMirror/React-safe insert path shared by every host: focus,
  // collapse to the end, then execCommand (contenteditable) or the native
  // setter + input events (textarea).
  function insertText(el, text) {
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

  function defaultSubmit(adapter) {
    const btn =
      adapter.submitSelector && document.querySelector(adapter.submitSelector);
    if (btn) {
      btn.click();
      return true;
    }
    const el = findComposer(adapter);
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

  function makeAdapter(partial) {
    return {
      insertText,
      submit() {
        return defaultSubmit(this);
      },
      isReady() {
        return !!findComposer(this);
      },
      ...partial,
    };
  }

  // ── The adapters ────────────────────────────────────────────────
  //
  // Selector values are comma-separated candidate lists, most specific
  // first, so a site redesign degrades instead of breaking outright.
  // `messageSelector` must NOT have a loose fallback: `scan()` reads the
  // last matching node, and a selector that matched the composer would
  // make our own inserted results re-trigger themselves.

  const ADAPTERS = {
    chatgpt: makeAdapter({
      host: "chatgpt",
      composerSelector: "#prompt-textarea, div[contenteditable='true'], textarea",
      submitSelector:
        'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], #composer-submit-button',
      messageSelector: '[data-message-author-role="assistant"]',
    }),

    claudeai: makeAdapter({
      host: "claudeai",
      composerSelector: 'div[contenteditable="true"]',
      submitSelector:
        'button[aria-label="Send message"], button[aria-label="Send"]',
      messageSelector: ".font-claude-message",
    }),

    gemini: makeAdapter({
      host: "gemini",
      composerSelector:
        'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"], div[contenteditable="true"]',
      submitSelector:
        'button[aria-label="Send message"], button[data-test-id="send-button"]',
      messageSelector:
        "model-response .markdown-content, .model-response-text, .markdown-content",
    }),

    grok: makeAdapter({
      host: "grok",
      composerSelector:
        'form textarea, textarea[aria-label], main textarea, textarea, div[contenteditable="true"]',
      submitSelector:
        'button[type="submit"], button[aria-label="Submit"], button[aria-label="Send message"]',
      messageSelector:
        ".response-content-markdown, .message-bubble, [data-testid='message-content']",
    }),

    // Last-resort adapter for a host we don't know yet. No message
    // selector: scanning stays off rather than misfiring on page chrome,
    // but composer insert/submit (handoff, manifest) still work.
    generic: makeAdapter({
      host: "generic",
      composerSelector: 'div[contenteditable="true"], textarea',
      submitSelector:
        'button[aria-label="Send message"], button[aria-label="Send"], button[type="submit"]',
      messageSelector: null,
    }),
  };

  /** Resolve the adapter for the current page. */
  function detect() {
    const h = location.hostname;
    if (h.includes("chatgpt.com") || h.includes("chat.openai.com")) {
      return ADAPTERS.chatgpt;
    }
    if (h.includes("claude.ai")) return ADAPTERS.claudeai;
    if (h.includes("gemini.google.com")) return ADAPTERS.gemini;
    if (h.includes("grok.com")) return ADAPTERS.grok;
    return ADAPTERS.generic;
  }

  function byHost(host) {
    return ADAPTERS[host] || ADAPTERS.generic;
  }

  globalThis.ACBAdapters = { ADAPTERS, detect, byHost, findComposer };
})();
