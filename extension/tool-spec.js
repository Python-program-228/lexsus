// AI Continuity Bridge — the shared tool vocabulary.
//
// One table describing every tool the bridge can execute, plus the parsers
// and formatters derived from it. This mirrors `SPECS` in
// `src-tauri/src/bridge.rs`; the two must stay in step.
//
// Loaded first by both content scripts (`content.js` for chatgpt.com,
// `content-any.js` for claude.ai/gemini.google.com) and by the service
// worker via `importScripts`. Before this existed the two content scripts
// carried duplicate copies of every parser and drifted apart.
//
// Exposed as `globalThis.ACBToolSpec`.

(() => {
  "use strict";

  // ── The table ───────────────────────────────────────────────────
  //
  // name       canonical wire name
  // variant    legacy v1 serde variant (`{"ReadFile":{...}}`)
  // aliases    other names a web AI might emit; resolved for JSON calls
  // args       [{ name, hint?, required?, multiline? }]
  // approval   auto | sensitive-path | always | destructive
  // autoInsert read-only result → paste straight into the composer
  // timeoutMs  must match the Rust spec's timeout_ms
  // lineRe     one-line call syntax. Absent → JSON block only.
  // stage      live progress label: verb + (args[arg] || fallback), or noun
  //
  // Array order is `parseToolLine`'s match precedence, so it is kept as it
  // was when these regexes lived in `content.js`. `manifest()` sorts by
  // group instead, so display order is independent of this.
  const TOOLS = [
    {
      name: "read_file",
      variant: "ReadFile",
      aliases: ["read", "view_file", "cat", "open_file"],
      args: [{ name: "path", required: true }],
      summary: "Read a file's contents",
      group: "Reading",
      approval: "sensitive-path",
      autoInsert: true,
      timeoutMs: 10000,
      lineRe: /read_file\s*[(:]\s*["']([^"'\s)]+)/i,
      lineArgs: ["path"],
      stage: { verb: "Reading", arg: "path", fallback: "file" },
    },
    {
      name: "write_file",
      variant: "WriteFile",
      aliases: ["write", "create_file", "put_file"],
      args: [
        { name: "path", required: true },
        { name: "content", required: true, multiline: true },
      ],
      summary: "Overwrite a file with new content",
      group: "Editing",
      approval: "always",
      autoInsert: false,
      timeoutMs: 15000,
      lineRe: /write_file\s*[(:]\s*["']([^"']+)["']\s*[,)\s]\s*["']([\s\S]*?)["']\s*\)?/i,
      lineArgs: ["path", "content"],
      stage: { verb: "Writing", arg: "path", fallback: "file" },
    },
    {
      name: "run_command",
      variant: "RunCommand",
      aliases: ["bash", "shell", "execute", "terminal", "sh"],
      args: [{ name: "command", hint: "shell command", required: true }],
      summary: "Run a shell command in the project root",
      group: "Commands",
      approval: "always",
      autoInsert: false,
      timeoutMs: 120000,
      // The quote is optional on purpose — models very often write the bare
      // `run_command: npm test`. That leniency is only safe because
      // `parseToolLine` anchors to the start of the line and `manifest()` is
      // not rendered in call syntax; without both, prose mentioning the tool
      // would execute. Do not loosen either without revisiting this.
      lineRe: /run_command\s*[(:]\s*["']?([^"'\n]+)["']?\s*\)?/i,
      lineArgs: ["command"],
      stage: { verb: "Running", arg: "command", fallback: "command" },
    },
    {
      name: "list_directory",
      variant: "ListDirectory",
      aliases: ["ls", "list_dir", "list", "dir"],
      args: [{ name: "path", required: true }],
      summary: "List the entries of a directory",
      group: "Reading",
      approval: "auto",
      autoInsert: true,
      timeoutMs: 10000,
      lineRe: /list_directory\s*[(:]\s*["']([^"']+)["']/i,
      lineArgs: ["path"],
      stage: { verb: "Listing", arg: "path", fallback: "directory" },
    },
    {
      name: "git_status",
      variant: "GitStatus",
      aliases: ["status", "git_st"],
      args: [],
      summary: "Show changed files in the git working tree",
      group: "Git",
      approval: "auto",
      autoInsert: true,
      timeoutMs: 10000,
      // Parens are required: the bare name appears in the manifest, in the
      // README's tool list and in ordinary prose, so matching the bare word
      // let any AI that echoed one of those silently run it.
      lineRe: /git_status\s*\(\s*\)/i,
      lineArgs: [],
      stage: { verb: "Fetching", noun: "git status" },
    },
    {
      name: "describe_tool",
      variant: "DescribeTool",
      aliases: ["tool_help", "help", "tool_info"],
      args: [{ name: "name", required: true }],
      summary: "Show the full argument schema for one tool",
      group: "Meta",
      approval: "auto",
      autoInsert: true,
      timeoutMs: 5000,
      lineRe: /describe_tool\s*[(:]\s*["']([^"']+)["']/i,
      lineArgs: ["name"],
      stage: { verb: "Fetching", arg: "name", fallback: "tool info" },
    },
    {
      name: "list_tools",
      variant: "ListTools",
      aliases: ["tools", "available_tools"],
      args: [],
      summary: "List every available tool, grouped",
      group: "Meta",
      approval: "auto",
      autoInsert: true,
      timeoutMs: 5000,
      // Parens are required: a bare `list_tools` appears inside the
      // manifest itself, so matching the bare word would let an AI that
      // echoes the manifest re-trigger it in a loop.
      lineRe: /list_tools\s*\(\s*\)/i,
      lineArgs: [],
      stage: { verb: "Fetching", noun: "the tool list" },
    },
  ];

  const GROUPS = ["Reading", "Editing", "Commands", "Search", "Git", "Planning", "Meta"];

  // ── Indexes ─────────────────────────────────────────────────────
  const BY_NAME = new Map();
  const BY_VARIANT = new Map();
  for (const spec of TOOLS) {
    BY_NAME.set(spec.name, spec);
    for (const alias of spec.aliases) BY_NAME.set(alias, spec);
    BY_VARIANT.set(spec.variant, spec);
  }

  /** Lowercase, `-`/space → `_`, and drop any `default_api.` style prefix. */
  function normalizeName(raw) {
    return String(raw ?? "")
      .split(".")
      .pop()
      .trim()
      .toLowerCase()
      .replace(/[\s-]/g, "_");
  }

  /** Resolve a canonical name or alias to its spec. */
  function specByName(raw) {
    return BY_NAME.get(normalizeName(raw)) || null;
  }

  /**
   * Normalize any of the three tool-object shapes in circulation into
   * `{ name, args, spec }`:
   *   - a parsed v2 call:  { name: "read_file", arguments: { path } }
   *   - a v2 result's meta: { tool: "read_file", path }
   *   - a legacy v1 enum:  { ReadFile: { path } }
   * Serde writes a v1 *unit* variant as the bare string "GitStatus", so a
   * plain string is accepted too.
   */
  function normalizeTool(tool) {
    if (typeof tool === "string") {
      const spec = BY_VARIANT.get(tool.trim()) || specByName(tool);
      return spec ? { name: spec.name, args: {}, spec } : null;
    }
    if (!tool || typeof tool !== "object") return null;

    for (const [variant, spec] of BY_VARIANT) {
      if (tool[variant] != null) {
        return { name: spec.name, args: tool[variant] || {}, spec };
      }
    }

    const spec = specByName(tool.name ?? tool.tool);
    if (!spec) {
      const name = normalizeName(tool.name ?? tool.tool);
      return name ? { name, args: tool.arguments || tool, spec: null } : null;
    }
    // A meta object carries its args inline rather than under `arguments`.
    return { name: spec.name, args: tool.arguments || tool, spec };
  }

  // ── Capture patterns ────────────────────────────────────────────
  // Priority 1: <acb_tool>…</acb_tool> tags (most reliable)
  const ACB_TAG_RE = /<acb_tool>([\s\S]*?)<\/acb_tool>/gi;
  // Priority 2: fenced JSON blocks (```acb or ```json)
  const FENCED_RE = /```(?:acb|json)\s*\n([\s\S]*?)```/gi;
  // Priority 4: bare inline JSON (fallback)
  const TOOL_KEY_RE = /["'](?:tool|name)["']\s*:/gi;

  /** The `{…}` starting at `start`, respecting strings and escapes. */
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

  /**
   * Parse one JSON tool object. Arguments are accepted either nested under
   * `arguments` or flat on the object, since models emit both.
   */
  function parseJsonBlock(body) {
    let obj;
    try {
      obj = JSON.parse(String(body).trim());
    } catch {
      return null;
    }
    const spec = specByName(obj.tool ?? obj.name);
    if (!spec) return null;

    const src = obj.arguments && typeof obj.arguments === "object" ? obj.arguments : {};
    const args = {};
    for (const arg of spec.args) {
      const raw = src[arg.name] ?? obj[arg.name];
      if (typeof raw !== "string") {
        if (arg.required) return null;
        continue;
      }
      args[arg.name] = raw;
    }
    return { name: spec.name, arguments: args };
  }

  /**
   * Leading noise a model puts in front of a call: list markers, blockquote
   * arrows, backticks, `1.` ordinals. Stripped before matching so a bulleted
   * call still fires.
   */
  const LINE_LEAD_RE = /^[\s>*\-+`]*(?:\d+[.)]\s*)?/;

  /**
   * Parse a one-line function-call form, e.g. `read_file("src/a.ts")`.
   *
   * The call must *begin* the line. Matching anywhere in the line meant prose
   * executed — "you can use run_command: npm test" opened a real approval
   * card, and any sentence naming a tool could run it.
   */
  function parseToolLine(line) {
    const text = String(line).replace(LINE_LEAD_RE, "");
    for (const spec of TOOLS) {
      if (!spec.lineRe) continue;
      const m = text.match(spec.lineRe);
      if (!m || m.index !== 0) continue;
      const args = {};
      spec.lineArgs.forEach((name, i) => {
        if (m[i + 1] != null) args[name] = m[i + 1];
      });
      // A required argument the regex failed to capture means the model
      // wrote something we shouldn't guess at.
      for (const arg of spec.args) {
        if (arg.required && typeof args[arg.name] !== "string") return null;
      }
      return { name: spec.name, arguments: args };
    }
    return null;
  }

  /**
   * Pull every tool call out of an assistant message. Returns the calls
   * plus the text with those regions blanked, so one-line scanning can
   * run over the remainder without double-capturing.
   */
  function extractTools(text) {
    const tools = [];
    const blanks = [];
    const inBlank = (i) => blanks.some(([s, e]) => i >= s && i < e);

    ACB_TAG_RE.lastIndex = 0;
    let m;
    while ((m = ACB_TAG_RE.exec(text)) !== null) {
      const tool = parseJsonBlock(m[1]);
      if (tool) {
        tools.push(tool);
        blanks.push([m.index, m.index + m[0].length]);
      }
    }

    FENCED_RE.lastIndex = 0;
    while ((m = FENCED_RE.exec(text)) !== null) {
      if (inBlank(m.index)) continue;
      const tool = parseJsonBlock(m[1]);
      if (tool) {
        tools.push(tool);
        blanks.push([m.index, m.index + m[0].length]);
      }
    }

    TOOL_KEY_RE.lastIndex = 0;
    let k;
    while ((k = TOOL_KEY_RE.exec(text)) !== null) {
      if (inBlank(k.index)) continue;
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

    // Each region is replaced with spaces of the same length, so the string
    // never shifts and `blanks` needs no sorting across the three passes.
    let rest = text;
    for (let i = blanks.length - 1; i >= 0; i--) {
      rest =
        rest.slice(0, blanks[i][0]) +
        " ".repeat(blanks[i][1] - blanks[i][0]) +
        rest.slice(blanks[i][1]);
    }
    return { tools, rest };
  }

  // ── Formatting ──────────────────────────────────────────────────

  /** Live progress label, e.g. `Reading src/a.ts`. */
  function stageLabel(tool) {
    const t = normalizeTool(tool);
    if (!t) return "Working…";
    const stage = t.spec && t.spec.stage;
    if (!stage) return `Fetching ${t.name}`;
    const subject = stage.arg ? t.args[stage.arg] || stage.fallback : stage.noun;
    return `${stage.verb} ${subject}`;
  }

  /** The call form, for docs. NOT for anything the AI might echo back. */
  function callSyntax(spec) {
    if (spec.args.length === 0) return spec.lineRe ? `${spec.name}()` : spec.name;
    const args = spec.args.map((a) => `"${a.hint || a.name}"`).join(", ");
    return `${spec.name}(${args})`;
  }

  /**
   * Grouped one-line-per-tool manifest. Kept terse on purpose.
   *
   * Deliberately rendered as an aligned table, NOT in call syntax. This text
   * is pasted into the chat, so the AI reliably echoes it back — and when it
   * did, `parseToolLine` matched every row and executed the entire tool
   * surface at once, approval cards and all. Six of the seven line regexes
   * require a quote after `(` or `:`, so omitting parens and quotes here is
   * what makes the manifest inert. Never format these rows as calls.
   */
  function manifest() {
    const lines = [];
    for (const group of GROUPS) {
      const rows = TOOLS.filter((t) => t.group === group);
      if (rows.length === 0) continue;
      lines.push(group);
      for (const s of rows) {
        const args = s.args.length ? s.args.map((a) => a.hint || a.name).join(", ") : "—";
        lines.push(`  ${s.name.padEnd(16)} ${args.padEnd(17)} ${s.summary}`);
      }
    }
    return lines.join("\n");
  }

  /** The tool instructions embedded in the handoff prompt. */
  function promptToolSection() {
    const jsonOnly = TOOLS.filter((t) => t.args.some((a) => a.multiline));
    const gated = TOOLS.filter((t) => t.approval === "always" || t.approval === "destructive");
    const example = jsonOnly[0] || TOOLS[0];
    return [
      `You are now the coding agent for the local project on the paired machine.`,
      `These tools execute on the real filesystem — call them, never simulate a result:`,
      ``,
      manifest(),
      ``,
      // `tool_name` resolves to no spec, so these two lines teach the syntax
      // without themselves being runnable calls.
      `Call a tool by writing its name at the start of its own line, with each`,
      `argument quoted, in the order the table's argument column lists them:`,
      ``,
      `  tool_name("first argument", "second argument")`,
      `  tool_name()   ← for a tool whose argument column shows —`,
      ``,
      `For ${jsonOnly.map((t) => t.name).join(", ")} — and ANY argument that spans multiple lines — you MUST instead emit an acb block containing one JSON object:`,
      '```acb',
      `{"tool":"${example.name}","path":"path/to/file.ext","content":"<entire new file content>"}`,
      '```',
      ``,
      `${gated.map((t) => t.name).join(" and ")} pause for the user's Allow/Deny — wait for the result rather than assuming it succeeded.`,
      `Each call is executed locally by the bridge and the real result is returned here. Never claim to have read, written, or run anything without the tool result.`,
    ].join("\n");
  }

  // ── Lookups used across the extension ───────────────────────────
  const AUTO_INSERT = new Set(TOOLS.filter((t) => t.autoInsert).map((t) => t.name));

  /** Read-only result the content script can paste into the composer. */
  function isAutoInsert(name) {
    const spec = specByName(name);
    return spec ? AUTO_INSERT.has(spec.name) : false;
  }

  /** Per-tool request timeout for the service worker. */
  const TIMEOUTS = Object.fromEntries(TOOLS.map((t) => [t.name, t.timeoutMs]));

  function timeoutFor(name) {
    const spec = specByName(name);
    return spec ? spec.timeoutMs : 15000;
  }

  // ChatGPT's composer is a ProseMirror contenteditable: an insert builds a
  // node tree for every line, inside React's input handling. `read_file`
  // allows 512KB (READ_CAP in bridge.rs), and pushing that in pegged the CPU
  // and froze the page. 24KB is roughly a large source file.
  const COMPOSER_CAP = 24 * 1024;

  /**
   * Trim a tool result to something a rich-text composer can absorb. The
   * marker names the real size so the AI knows it saw only a prefix.
   */
  function capForComposer(text) {
    const s = String(text ?? "");
    if (s.length <= COMPOSER_CAP) return s;
    return `${s.slice(0, COMPOSER_CAP)}\n\n[truncated at ${COMPOSER_CAP} of ${s.length} bytes]`;
  }

  globalThis.ACBToolSpec = {
    TOOLS,
    GROUPS,
    TIMEOUTS,
    AUTO_INSERT,
    COMPOSER_CAP,
    normalizeName,
    specByName,
    normalizeTool,
    parseJsonBlock,
    parseToolLine,
    extractTools,
    balancedObjectAt,
    stageLabel,
    callSyntax,
    manifest,
    promptToolSection,
    isAutoInsert,
    timeoutFor,
    capForComposer,
  };
})();
