# AI Continuity Bridge — Communication Protocol v2.0

## 1. Overview

This document specifies the wire protocol between the Chrome Extension (content script + background service worker) and the Rust/Tauri desktop application over a local WebSocket.

**Transport:** WebSocket over TCP, loopback only (`ws://127.0.0.1:45241`)
**Framing:** JSON text messages (no binary frames)
**Authentication:** 6-digit pairing code, exchanged on connection

---

## 2. Connection Lifecycle

```
Extension                          Rust App
   |                                   |
   |──── TCP connect ─────────────────>|
   |──── WebSocket handshake ─────────>|
   |                                   |
   |──── {"type":"pair",               |
   |      "code":"123456",            |
   |      "proto":2} ────────────────>|
   |                                   |
   |<──── {"type":"pair-ok",           |
   |       "proto":2,                 |
   |       "server_version":"0.2.0"} ─|
   |                                   |
   |   [Connection ready]              |
   |                                   |
   |──── {"type":"ping"} ────────────>|
   |<──── {"type":"pong"} ───────────|
   |   (every 15s)                     |
   |                                   |
   |   [If no pong in 45s → reconnect] |
```

**Reconnection:** Exponential backoff (1s → 2s → 4s → 8s → 30s cap). On reconnect, auto-re-pair with stored code.

---

## 3. Message Envelope

All messages follow this structure:

```jsonc
{
  "id": "uuid-v4",           // Unique request ID (for request-response matching)
  "type": "message_type",    // One of the defined types
  "proto": 2,                // Protocol version (optional on non-pair messages)
  "timestamp": 1724000000000 // Unix ms (for logging/debugging)
}
```

---

## 4. Message Types

### Extension → Rust

| Type | Purpose | Required Fields |
|------|---------|-----------------|
| `pair` | Authenticate | `code`, `proto` |
| `ping` | Heartbeat | — |
| `tool_call` | Execute a tool | `id`, `tool`, `arguments` |
| `tool_approve` | User approved/denied | `id`, `allow` |
| `handoff_request` | Request handoff build | — |
| `cancel` | Cancel pending request | `id` |

### Rust → Extension

| Type | Purpose | Required Fields |
|------|---------|-----------------|
| `pair_ok` | Pairing succeeded | `proto`, `server_version` |
| `pair_error` | Pairing failed | `error` |
| `pong` | Heartbeat response | — |
| `tool_result` | Tool execution result | `id`, `status`, `result?`, `error?`, `meta?` |
| `tool_stream` | Streaming output chunk | `id`, `chunk`, `stream_id` |
| `handoff` | Pushed handoff payload | `payload` |
| `handoff_error` | Handoff build failed | `error` |

---

## 5. Tool Call Request

```jsonc
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "tool_call",
  "tool": "read_file",
  "arguments": {
    "path": "src/App.tsx",
    "offset": 0,
    "limit": 1000
  },
  "timestamp": 1724000000000
}
```

---

## 6. Tool Result

```jsonc
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "tool_result",
  "status": "success",       // "success" | "error" | "pending" | "denied" | "timeout"
  "result": {
    "output": "file contents...",
    "bytes": 12345
  },
  "error": null,
  "meta": {
    "tool": "read_file",
    "duration_ms": 42,
    "path": "src/App.tsx"
  }
}
```

### Status Values

| Status | Meaning | `result` | `error` |
|--------|---------|----------|---------|
| `success` | Tool executed OK | `{ output, bytes? }` | `null` |
| `error` | Tool failed | `null` | `{ code, message }` |
| `pending` | Awaiting user approval | `{ summary }` | `null` |
| `denied` | User denied the action | `null` | `{ code: "DENIED", message }` |
| `timeout` | Execution timed out | `null` | `{ code: "TIMEOUT", message }` |

---

## 7. Error Codes

| Code | Category | Auto-Retry |
|------|----------|------------|
| `FILE_NOT_FOUND` | Validation | No |
| `FILE_IS_BINARY` | Validation | No |
| `FILE_TOO_LARGE` | Validation | No |
| `PATH_ESCAPES_ROOT` | Security | No |
| `PERMISSION_DENIED` | Security | No |
| `SENSITIVE_PATH` | Security | No |
| `INVALID_ARGUMENTS` | Validation | No |
| `MALFORMED_JSON` | Detection | No |
| `EXECUTION_FAILED` | Runtime | Maybe |
| `COMMAND_TIMEOUT` | Runtime | Maybe |
| `CONNECTION_LOST` | Transport | Yes |
| `NOT_PAIRED` | Auth | No |
| `UNKNOWN_TOOL` | Validation | No |
| `INTERNAL_ERROR` | Server | Yes |
| `DENIED` | User | No |

---

## 8. Tool Definitions

Implemented today. Names are resolved through the shared spec table
(`src-tauri/src/bridge.rs::SPECS`, mirrored in `extension/tool-spec.js`), which
also accepts per-tool aliases — a model that emits `Read`, `bash` or
`default_api.read_file` still lands on the right tool.

| Tool | Required Args | Optional Args | Max Output | Approval |
|------|---------------|---------------|------------|----------|
| `read_file` | `path: string` | — | 512KB | Auto (unless sensitive) |
| `write_file` | `path, content` | — | — | Always |
| `run_command` | `command` | — | 1MB | Always |
| `list_directory` | `path` | — | 256KB | Auto |
| `git_status` | — | — | 64KB | Auto |
| `describe_tool` | `name` | — | — | Auto |
| `list_tools` | — | — | — | Auto |

`describe_tool` and `list_tools` answer from the spec table alone, so they work
before a project is opened — an AI that has lost the manifest can always
recover it.

Reserved by the protocol but **not yet implemented** (the core returns
`UNKNOWN_TOOL`): `search_files`/`grep`, `glob`, `edit_file`, the `git_*` write
tools, and the `offset`/`limit`, `recursive`/`max_depth`, `cwd`/`timeout_ms`
optional args above.

---

## 9. Tool Call Detection (Extension)

**Priority Order:**

1. `<acb_tool>` tags (highest reliability)
2. Fenced JSON blocks (```acb` or ```json`)
3. Function-call syntax (`read_file("path")`)
4. Inline JSON (lowest priority)

**Streaming Safety:**
- For `<acb_tool>` blocks: Wait for closing `</acb_tool>` tag
- For fenced blocks: Wait for closing ``` before extracting
- For function calls: Use balanced-paren matcher, wait for closing `)`
- Debounce: 800ms after last DOM mutation before scanning

**Deduplication:**
- Content-script level: `Set<string>` of JSON-serialized tool calls (FIFO, 200 max)
- Background level: `Map<string, {id, timestamp}>` of tool signatures (TTL 60s)

---

## 10. Request-Response Matching

- Extension generates UUID v4 for each tool call
- Background maintains `Map<id, {tool, timestamp, retries}>` for pending requests
- Rust echoes the `id` back in all responses for that request

**Timeout per Request:**

Derived from the shared spec table, not hardcoded per call site.

| Tool | Timeout | Retry |
|------|---------|-------|
| `read_file` | 10s | 1 |
| `write_file` | 15s | 0 |
| `run_command` | 120s | 0 |
| `list_directory` | 10s | 1 |
| `git_status` | 10s | 1 |
| `describe_tool` | 5s | 1 |
| `list_tools` | 5s | 1 |
| _unknown_ | 15s | 0 |

---

## 11. Streaming Output

For `run_command`, the Rust side can stream output chunks:

```jsonc
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "type": "tool_stream",
  "stream_id": "run_123",
  "chunk": {
    "kind": "output",        // "start" | "output" | "exit"
    "data": "PASS  auth.test.ts\n"
  },
  "timestamp": 1724000000000
}
```

---

## 12. Sequence Diagrams

### Success Flow — read_file

```
ChatGPT          Extension (content)    Extension (bg)        Rust App
   |                    |                    |                    |
   | outputs tool call  |                    |                    |
   |───────────────────>|                    |                    |
   |                    | sendTool({tool})   |                    |
   |                    |───────────────────>|                    |
   |                    |                    | tool_call (id=abc) |
   |                    |                    |───────────────────>|
   |                    |                    |                    | validate
   |                    |                    |                    | read file
   |                    |                    |                    | audit
   |                    |                    | tool_result (abc)  |
   |                    |                    |<───────────────────|
   |                    | tool-result (abc)  |                    |
   |                    |<───────────────────|                    |
   |                    | showToolWidget()   |                    |
```

### Success Flow — write_file (with approval)

```
ChatGPT          Extension (content)    Extension (bg)        Rust App
   |                    |                    |                    |
   | outputs acb block  |                    |                    |
   |───────────────────>|                    |                    |
   |                    | sendTool({tool})   |                    |
   |                    |───────────────────>|                    |
   |                    |                    | tool_call (abc)    |
   |                    |                    |───────────────────>|
   |                    |                    |                    | validate
   |                    |                    |                    | needs approval
   |                    |                    | tool_result (abc)  |
   |                    |                    |    status: pending |
   |                    |<───────────────────|                    |
   |                    | showToolCard()     |                    |
   |                    | render Allow/Deny  |                    |
   | user clicks Allow  |                    |                    |
   |                    | tool_approve       |                    |
   |                    |───────────────────>|                    |
   |                    |                    | approve (abc)      |
   |                    |                    |───────────────────>|
   |                    |                    |                    | execute
   |                    |                    |                    | audit
   |                    |                    | tool_result (abc)  |
   |                    |                    |<───────────────────|
   |                    | tool-result (abc)  |                    |
   |                    |<───────────────────|                    |
   |                    | showResultBlock()  |                    |
```

### Error Flow — file not found

```
ChatGPT          Extension (content)    Extension (bg)        Rust App
   |                    |                    |                    |
   | outputs tool call  |                    |                    |
   |───────────────────>|                    |                    |
   |                    | sendTool({tool})   |                    |
   |                    |───────────────────>|                    |
   |                    |                    | tool_call (abc)    |
   |                    |                    |───────────────────>|
   |                    |                    |                    | validate
   |                    |                    |                    | file not found
   |                    |                    | tool_result (abc)  |
   |                    |                    |   status: error    |
   |                    |                    |   error: FILE_NOT_FOUND
   |                    |<───────────────────|                    |
   |                    | showErrorWidget()  |                    |
```

### Connection Drop & Recovery

```
Extension (bg)                       Rust App
   |                                    |
   |   [WebSocket closes]              |
   |                                    |
   | set ws_connected = false          |
   | clear pending requests            |
   | notify content scripts            |
   |                                    |
   | scheduleReconnect(1s)             |
   |                                    |
   |──── TCP connect ─────────────────>|
   |──── WebSocket handshake ─────────>|
   |──── pair (code) ────────────────>|
   |<──── pair-ok ────────────────────|
   |                                    |
   | set ws_connected = true           |
   |                                    |
   |   [Pending requests were lost     |
   |    AI must re-emit tool calls]    |
```

---

## 13. Best Practices

### Extension Side

1. Always use `<acb_tool>` tags — instruct the AI to use explicit tags
2. Wait for complete JSON — never fire on partial streaming output
3. Signature-based dedup — JSON-serialize the tool call, check against Set
4. Request-response matching — use UUID, track pending requests with timeouts
5. Graceful degradation — if WS is down, show "offline" status

### Rust Side

1. Validate everything — tool name, arguments, paths, permissions
2. Audit every call — record to SQLite regardless of outcome
3. Timeout enforcement — every tool execution has a hard timeout
4. Output capping — prevent memory exhaustion from large outputs
5. Error specificity — use precise error codes, not generic strings

### Protocol Level

1. Protocol versioning — negotiate on pair, reject incompatible versions
2. Idempotency — retrying the same `id` should return the same result
3. Message size limits — reject messages > 10MB
4. Graceful close — send `close` frame before disconnecting
