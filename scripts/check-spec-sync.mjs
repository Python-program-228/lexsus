// Verify extension/tool-spec.js mirrors src-tauri/src/bridge.rs SPECS.
// The two tables are hand-maintained, so drift between them is the standing
// risk that the shared spec table was introduced to eliminate.
//
//   node scripts/check-spec-sync.mjs
import { readFileSync } from "node:fs";

const ROOT = process.argv[2] || ".";
const rust = readFileSync(`${ROOT}/src-tauri/src/bridge.rs`, "utf8");
await import(`${process.cwd()}/${ROOT}/extension/tool-spec.js`);
const S = globalThis.ACBToolSpec;

const APPROVAL = {
  Auto: "auto",
  SensitivePathOnly: "sensitive-path",
  Always: "always",
  Destructive: "destructive",
};

// Parse the SPECS table out of bridge.rs.
const specsBlock = rust.slice(
  rust.indexOf("pub const SPECS"),
  rust.indexOf("/// Canonical name of a tool variant"),
);
const rows = new Map();
for (const m of specsBlock.matchAll(/ToolSpec \{([\s\S]*?)\n    \},/g)) {
  const body = m[1];
  const get = (re) => (body.match(re) || [])[1];
  const name = get(/name:\s*"([^"]+)"/);
  if (!name) continue;
  rows.set(name, {
    name,
    aliases: [...(get(/aliases:\s*&\[([^\]]*)\]/) || "").matchAll(/"([^"]+)"/g)].map((a) => a[1]),
    approval: APPROVAL[get(/approval:\s*Approval::(\w+)/)],
    timeoutMs: Number((get(/timeout_ms:\s*([\d_]+)/) || "0").replace(/_/g, "")),
    autoInsert: get(/auto_insert:\s*(\w+)/) === "true",
    group: get(/group:\s*"([^"]+)"/),
  });
}

const problems = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const js of S.TOOLS) {
  const rs = rows.get(js.name);
  if (!rs) {
    problems.push(`${js.name}: in tool-spec.js but not in Rust SPECS`);
    continue;
  }
  for (const field of ["approval", "timeoutMs", "autoInsert", "group"]) {
    if (!eq(js[field], rs[field])) {
      problems.push(
        `${js.name}.${field}: js=${JSON.stringify(js[field])} rust=${JSON.stringify(rs[field])}`,
      );
    }
  }
  if (!eq([...js.aliases].sort(), [...rs.aliases].sort())) {
    problems.push(`${js.name}.aliases: js=[${js.aliases}] rust=[${rs.aliases}]`);
  }
}
for (const name of rows.keys()) {
  if (!S.TOOLS.some((t) => t.name === name)) {
    problems.push(`${name}: in Rust SPECS but not in tool-spec.js`);
  }
}

// Names and aliases must be globally unique or resolution is order-dependent.
const claimed = new Map();
for (const t of S.TOOLS) {
  for (const n of [t.name, ...t.aliases]) {
    if (claimed.has(n)) problems.push(`"${n}" claimed by both ${claimed.get(n)} and ${t.name}`);
    claimed.set(n, t.name);
  }
  if (!S.GROUPS.includes(t.group)) problems.push(`${t.name}: group "${t.group}" not in GROUPS`);
}

const manifest = S.manifest();
console.log(`Rust SPECS rows:    ${rows.size}`);
console.log(`tool-spec.js TOOLS: ${S.TOOLS.length}`);
console.log(`manifest:           ${manifest.length} bytes (~${Math.round(manifest.length / 4)} tokens)`);
console.log("");
console.log(manifest);
console.log("");

// Spot-check alias resolution and the parsers end to end.
const bare = "  list_tools — List every available tool, grouped";
const tagged = 'x <acb_tool>{"tool":"git_status"}</acb_tool> y';
const checks = [
  ["specByName Read", S.specByName("Read")?.name === "read_file"],
  ["specByName default_api.write_file", S.specByName("default_api.write_file")?.name === "write_file"],
  ["specByName list-dir", S.specByName("list-dir")?.name === "list_directory"],
  ["specByName teleport is null", S.specByName("teleport") === null],
  ['parseToolLine read_file("a.ts")', S.parseToolLine('read_file("a.ts")')?.arguments.path === "a.ts"],
  ["parseToolLine list_tools() fires", S.parseToolLine("list_tools()")?.name === "list_tools"],
  ["parseToolLine bare list_tools does NOT fire", S.parseToolLine(bare) === null],
  ["parseJsonBlock alias", S.parseJsonBlock('{"tool":"cat","path":"a.ts"}')?.name === "read_file"],
  ["parseJsonBlock rejects missing arg", S.parseJsonBlock('{"tool":"read_file"}') === null],
  ["parseJsonBlock ignores prose name", S.parseJsonBlock('{"name":"Alex","age":3}') === null],
  ["normalizeTool v1 object", S.normalizeTool({ ReadFile: { path: "a" } })?.name === "read_file"],
  ["normalizeTool v1 unit string", S.normalizeTool("GitStatus")?.name === "git_status"],
  ["normalizeTool v2 meta", S.normalizeTool({ tool: "write_file", path: "a" })?.name === "write_file"],
  ["stageLabel v2 meta", S.stageLabel({ tool: "run_command", command: "npm test" }) === "Running npm test"],
  ["isAutoInsert read_file", S.isAutoInsert("read_file") === true],
  ["isAutoInsert run_command", S.isAutoInsert("run_command") === false],
  ["timeoutFor unknown is 15000", S.timeoutFor("nope") === 15000],
  ["extractTools preserves length", S.extractTools(tagged).rest.length === tagged.length],
  ["extractTools finds the call", S.extractTools(tagged).tools[0]?.name === "git_status"],

  // A call must begin its line. Matching mid-sentence meant prose executed:
  // "you can use run_command: npm test" opened a real approval card.
  ["prose run_command inert", S.parseToolLine("you can use run_command: npm test to test") === null],
  ["prose read_file inert", S.parseToolLine('then I will read_file("a.ts") for you') === null],
  ["bare git_status inert", S.parseToolLine("git_status shows changed files") === null],
  ["git_status() fires", S.parseToolLine("git_status()")?.name === "git_status"],
  ["bulleted call fires", S.parseToolLine('- `read_file("a.ts")`')?.name === "read_file"],
  ["numbered call fires", S.parseToolLine('2. read_file("a.ts")')?.name === "read_file"],
  ["lenient run_command still fires", S.parseToolLine("run_command: npm test")?.arguments.command === "npm test"],

  // Oversized results must not reach a rich-text composer whole.
  ["composer cap marks size", S.capForComposer("x".repeat(30000)).includes("truncated at 24576 of 30000")],
  ["composer cap passes small text through", S.capForComposer("hi") === "hi"],
  ["composer cap handles null", S.capForComposer(null) === ""],

  // Chunked reads: the core's footer says `read_file("f", 401)`, so following
  // it must parse — with 401 as a *number*, since the Rust side reads a u32.
  ["chunk offset parses", S.parseToolLine('read_file("README.md", 401)')?.arguments.offset === 401],
  ["chunk offset is a number", typeof S.parseToolLine('read_file("a.ts", 7)')?.arguments.offset === "number"],
  ["path-only read still parses", S.parseToolLine('read_file("a.ts")')?.arguments.offset === undefined],
  ["unterminated quote still parses", S.parseToolLine('read_file("a.ts')?.arguments.path === "a.ts"],
  ["json offset number", S.parseJsonBlock('{"tool":"read_file","path":"a","offset":401}')?.arguments.offset === 401],
  ["json offset quoted digits", S.parseJsonBlock('{"tool":"read_file","path":"a","offset":"401"}')?.arguments.offset === 401],
  ["json offset garbage dropped", S.parseJsonBlock('{"tool":"read_file","path":"a","offset":"soon"}')?.arguments.offset === undefined],
  ["json read_file still needs a path", S.parseJsonBlock('{"tool":"read_file","offset":2}') === null],
];

// The manifest and the handoff prompt are pasted into the chat, so the AI
// echoes them back into the scanner. Every line must be inert — when the
// manifest was generated in call syntax, echoing it ran the whole tool
// surface at once (two approval cards plus a self-referential list_tools).
const promptText = S.promptToolSection();
for (const line of promptText.split("\n")) {
  const hit = S.parseToolLine(line.trim());
  if (hit) problems.push(`prompt line executes ${hit.name}: ${JSON.stringify(line)}`);
}
// The ```acb example must still teach the JSON form, so write_file is the one
// expected hit; anything else means a block leaked in.
const jsonHits = S.extractTools(promptText).tools.map((t) => t.name);
const unexpected = jsonHits.filter((n) => n !== "write_file");
if (unexpected.length) problems.push(`prompt JSON fires ${unexpected.join(", ")}`);
if (!jsonHits.includes("write_file")) {
  problems.push("prompt no longer teaches a parseable acb block");
}

for (const [label, ok] of checks) {
  if (!ok) problems.push(`behaviour check failed: ${label}`);
}

// The chunk footer is auto-inserted into the chat, so the AI echoes it back.
// It must NOT fire on its own — the model has to decide to page and write the
// call itself. The leading `[` is what makes it inert (the anchor in
// `parseToolLine` strips list markers, not brackets), so both halves of this
// pairing matter: keep the format in sync with `chunk_text` in bridge.rs.
const FOOTER = '[to continue, call: read_file("README.md", 401)]';
if (!rust.includes('"[to continue, call: read_file(\\"{}\\", {})]\\n"')) {
  problems.push("bridge.rs's chunk footer format changed — re-check the FOOTER inertness test");
}
if (S.parseToolLine(FOOTER) !== null) {
  problems.push("chunk footer parses as a call — echoing a read would re-fire it");
}

if (problems.length) {
  console.log(`FAIL - ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`ok - ${S.TOOLS.length} tools aligned, ${checks.length} behaviour checks passed`);
