// Node smoke test for the extension's adapter layer and MCP tool
// registration (Phase 1). Run: node scripts/test-adapters.mjs
//
// chat-adapters.js touches `document`/`window` only inside functions, so
// it loads fine in Node with a minimal globalThis stub.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function ok(cond, label) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// Load the two scripts into this context (they assign to globalThis).
eval(readFileSync(join(ROOT, "extension/tool-spec.js"), "utf8"));
eval(readFileSync(join(ROOT, "extension/chat-adapters.js"), "utf8"));

const S = globalThis.ACBToolSpec;
const A = globalThis.ACBAdapters;

ok(S && A, "tool-spec.js and chat-adapters.js load");

// Every supported host has an adapter with the required surface.
for (const h of ["chatgpt", "claudeai", "gemini", "grok"]) {
  const a = A.byHost(h);
  ok(a && a.host === h, `adapter for ${h}`);
  ok(typeof a.composerSelector === "string", `${h}: composerSelector`);
  ok(typeof a.messageSelector === "string", `${h}: messageSelector`);
  ok(typeof a.submit === "function", `${h}: submit()`);
  ok(typeof a.isReady === "function", `${h}: isReady()`);
}

// Unknown hosts fall back to the generic adapter with scanning off.
const g = A.byHost("example");
ok(g.host === "generic", "unknown host → generic adapter");
ok(g.messageSelector === null, "generic adapter does not scan");

// MCP tool registration is dynamic and idempotent.
const before = S.TOOLS.length;
const added = S.registerMcpTools([
  {
    server: "macos",
    name: "get_mouse_position",
    wire_name: "mcp__macos__get_mouse_position",
    description: "Get the mouse cursor position",
    read_only: true,
  },
  {
    server: "macos",
    name: "click",
    wire_name: "mcp__macos__click",
    description: "Click at a position",
    read_only: false,
  },
]);
ok(added === 2, "registerMcpTools adds both tools");
ok(S.TOOLS.length === before + 2, "TOOLS grew by 2");
ok(S.registerMcpTools([{ wire_name: "mcp__macos__click" }]) === 0, "re-registration is a no-op");

const ro = S.specByName("mcp__macos__get_mouse_position");
ok(ro && ro.approval === "auto", "read-only MCP tool auto-approves");
const rw = S.specByName("mcp__macos__click");
ok(rw && rw.approval === "always", "write-capable MCP tool always asks");
ok(S.timeoutFor("mcp__macos__click") === 60000, "MCP timeout is 60s");
ok(S.isAutoInsert("mcp__macos__get_mouse_position"), "read-only result auto-inserts");
ok(!S.isAutoInsert("mcp__macos__click"), "write result never auto-inserts");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall adapter/MCP checks passed");
