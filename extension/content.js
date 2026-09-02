// AI Continuity Bridge — chatgpt.com content script v3 (Agent Runtime).
//
// All logic lives in content-core.js; all host specifics in
// chat-adapters.js. This file only pins the host so an accidental
// injection onto another page can't cross-wire adapters.
// tool-spec.js, chat-adapters.js, ui-components.js run before this
// (manifest content_scripts order).

window.ACBContentCore?.boot("chatgpt");
