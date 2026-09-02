// AI Continuity Bridge — content script v3 for the non-ChatGPT web AIs:
// claude.ai, gemini.google.com and grok.com (Agent Runtime).
//
// All logic lives in content-core.js; the host is auto-detected by
// chat-adapters.js from the page's hostname. tool-spec.js,
// chat-adapters.js, ui-components.js run before this (manifest
// content_scripts order).

window.ACBContentCore?.boot();
