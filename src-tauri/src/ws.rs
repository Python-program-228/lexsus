//! Local WebSocket server (M2): the browser extension pairs with the
//! desktop app over `ws://127.0.0.1:45241` using a 6-digit pairing code,
//! then relays web-AI tool calls and receives handoffs.
//!
//! Loopback-only, no TLS: the endpoint is bound to 127.0.0.1 and the
//! pairing code gates every connection.
//!
//! Protocol v2 (JSON):
//!   ext → app: {"type":"pair","code":"123456","proto":2}
//!   app → ext: {"type":"pair-ok","proto":2,"server_version":"0.2.0"}
//!   ext → app: {"type":"tool_call","id":"<uuid>","tool":"read_file","arguments":{...}}
//!   app → ext: {"type":"tool_result","id":"<uuid>","status":"success","result":{...}}
//!   ext → app: {"type":"ping"} → {"type":"pong"}
//!   app → ext: {"type":"handoff","payload":{...}}  (pushed)
//!
//! Gated tools return a "pending" tool_result only in the sense that the
//! tool_call blocks until the desktop UI resolves the approval — the
//! WebSocket can never resolve one. An earlier protocol let the extension
//! send {"type":"tool_approve"}, but the extension's approval buttons
//! lived in the host page's DOM, where any page script could approve via
//! a synthetic click, so that path was removed. Approvals resolve solely
//! through the desktop app (`bridge_approve` in lib.rs).
//!
//! Protocol v1 (legacy, still accepted):
//!   ext → app: {"type":"tool","id":1,"tool":{"ReadFile":{"path":"..."}}}
//!   app → ext: {"type":"tool-result","id":1,"result":{...}}

use crate::AppState;
use serde_json::json;
use std::io::ErrorKind;
use std::net::TcpListener;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::protocol::Message;

pub const ADDR: &str = "127.0.0.1:45241";
pub const PROTOCOL_VERSION: u32 = 2;
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Pairing brute-force throttle. Six digits = 900k possibilities, and any
/// local process can open a socket to the loopback port — without a
/// lockout the code is brute-forceable in minutes. Five failed guesses
/// lock pairing for a minute, and every wrong guess costs half a second
/// before the rejection is sent.
static PAIR_FAILURES: AtomicU32 = AtomicU32::new(0);
static PAIR_LOCKED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
const MAX_PAIR_FAILURES: u32 = 5;
const PAIR_LOCKOUT: Duration = Duration::from_secs(60);
const PAIR_FAIL_DELAY: Duration = Duration::from_millis(500);

/// Generate a fresh 6-digit pairing code from the OS CSPRNG. The previous
/// clock-nanoseconds derivation was predictable — an attacker who could
/// guess roughly when the code was generated had a tiny search space.
pub fn new_pair_code() -> String {
    let mut buf = [0u8; 4];
    getrandom::getrandom(&mut buf).expect("OS CSPRNG unavailable");
    let n = u32::from_le_bytes(buf) % 900_000 + 100_000;
    format!("{n:06}")
}

/// Only browser extensions may open this socket. A missing `Origin` is a
/// non-browser local client; a web-page origin (http/https/file) must be
/// rejected at the handshake — that is a page probing localhost, which is
/// exactly the threat the pairing code exists for.
fn origin_allowed(req: &Request) -> bool {
    match req.headers().get("Origin") {
        None => true,
        Some(v) => {
            let s = v.to_str().unwrap_or("");
            s.starts_with("chrome-extension://") || s.starts_with("moz-extension://")
        }
    }
}

/// Bind the listener and accept connections forever (detached thread).
pub fn spawn_server(app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(ADDR) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[ws] failed to bind {ADDR}: {e}");
                return;
            }
        };
        eprintln!("[ws] listening on ws://{ADDR}");
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let app = app.clone();
                    std::thread::spawn(move || handle_conn(app, stream));
                }
                Err(e) => eprintln!("[ws] accept error: {e}"),
            }
        }
    });
}

/// Build a v2 tool_result message.
fn make_tool_result_v2(
    id: &str,
    status: &str,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
    meta: Option<serde_json::Value>,
) -> String {
    json!({
        "type": "tool_result",
        "id": id,
        "status": status,
        "result": result,
        "error": error,
        "meta": meta,
        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
    })
    .to_string()
}

/// Build a v1 tool-result message (legacy).
fn make_tool_result_v1(id: u64, result: &crate::bridge::ToolResult) -> String {
    json!({
        "type": "tool-result",
        "id": id,
        "result": result,
    })
    .to_string()
}

/// Response metadata for a v2 tool_result. The tool name comes from the
/// spec table; the `path` / `command` keys are read directly by the
/// extension's result renderer (`content.js`), so they stay as-is.
fn tool_meta(tool: &crate::bridge::Tool) -> serde_json::Value {
    use crate::bridge::Tool;
    let name = crate::bridge::tool_name(tool);
    let mut meta = json!({"tool": name});
    match tool {
        Tool::ReadFile { path, .. }
        | Tool::WriteFile { path, .. }
        | Tool::ListDirectory { path } => {
            meta["path"] = json!(path);
        }
        Tool::RunCommand { command } => {
            meta["command"] = json!(command);
        }
        Tool::McpCall { server, tool, .. } => {
            meta["server"] = json!(server);
            meta["mcp_tool"] = json!(tool);
        }
        Tool::GitStatus | Tool::DescribeTool { .. } | Tool::ListTools => {}
    }
    if let Some(detail) = crate::bridge::detail(tool) {
        meta["detail"] = json!(detail);
    }
    meta
}

/// Parse a v2 tool_call message into a Tool enum. The name is resolved
/// through the spec table's aliases first, because a web AI emits whatever
/// name it happens to remember (`Read`, `bash`, `default_api.read_file`).
fn parse_tool_call_v2(
    tool_name: &str,
    args: &serde_json::Value,
) -> Result<crate::bridge::Tool, String> {
    // Namespaced MCP wire name (`mcp__<server>__<tool>`): the read_only
    // flag comes from the server's cached `annotations.readOnlyHint`
    // (unknown → false → the call goes through Always approval).
    if tool_name.starts_with("mcp__") {
        let (server, tool) = crate::mcp::McpManager::parse_wire_name(tool_name)
            .ok_or_else(|| format!("bad MCP tool name: {tool_name}"))?;
        let read_only = crate::mcp::manager().tool_is_read_only(&server, &tool);
        return Ok(crate::bridge::Tool::McpCall {
            server,
            tool,
            args: args.clone(),
            read_only,
        });
    }
    let spec = crate::bridge::spec_by_name(tool_name)
        .ok_or_else(|| format!("unknown tool: {tool_name}"))?;
    let str_arg = |key: &str| -> Result<String, String> {
        args[key]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| format!("missing '{key}' argument"))
    };
    // Line numbers arrive as a JSON number from our own parser, but a web AI
    // writing raw JSON often quotes them.
    let u32_arg = |key: &str| -> Option<u32> {
        args[key]
            .as_u64()
            .or_else(|| args[key].as_str().and_then(|s| s.trim().parse().ok()))
            .map(|n| n.min(u32::MAX as u64) as u32)
    };
    match spec.name {
        "read_file" => Ok(crate::bridge::Tool::ReadFile {
            path: str_arg("path")?,
            offset: u32_arg("offset"),
            limit: u32_arg("limit"),
        }),
        "write_file" => Ok(crate::bridge::Tool::WriteFile {
            path: str_arg("path")?,
            content: str_arg("content")?,
        }),
        "run_command" => Ok(crate::bridge::Tool::RunCommand {
            command: str_arg("command")?,
        }),
        "list_directory" => Ok(crate::bridge::Tool::ListDirectory {
            path: str_arg("path")?,
        }),
        "git_status" => Ok(crate::bridge::Tool::GitStatus),
        "describe_tool" => Ok(crate::bridge::Tool::DescribeTool {
            name: str_arg("name")?,
        }),
        "list_tools" => Ok(crate::bridge::Tool::ListTools),
        "mcp_call" => {
            let server = str_arg("server")?;
            let tool = str_arg("tool")?;
            let read_only = crate::mcp::manager().tool_is_read_only(&server, &tool);
            Ok(crate::bridge::Tool::McpCall {
                server,
                tool,
                args: args.get("args").cloned().unwrap_or(serde_json::json!({})),
                read_only,
            })
        }
        other => Err(format!("tool not implemented: {other}")),
    }
}

fn handle_conn(app: AppHandle, stream: std::net::TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .ok();
    // accept_hdr lives at the crate root (tungstenite re-exports it from the
    // private `server` module), while the Request/Response types come from
    // `handshake::server` — hence the two different paths below.
    let ws = match tungstenite::accept_hdr(
        stream,
        |req: &Request, resp: Response| {
            if origin_allowed(req) {
                Ok(resp)
            } else {
                eprintln!("[ws] handshake rejected: origin not allowed");
                // A statically-valid 403 can't fail to build; unwrap is safe.
                Err(tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("origin not allowed".into()))
                    .unwrap())
            }
        },
    ) {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[ws] handshake failed: {e}");
            return;
        }
    };

    let ws = Arc::new(Mutex::new(ws));
    let mut paired = false;

    loop {
        let msg = {
            let mut w = ws.lock().unwrap();
            match w.read() {
                Ok(Message::Text(text)) => {
                    // Hard frame cap: a multi-GB paste must not OOM the
                    // app. 10 MB is far above any legitimate tool call.
                    if text.len() > 10 * 1024 * 1024 {
                        let _ = w.send(Message::Text(
                            json!({"type": "error", "error": "frame too large"}).to_string(),
                        ));
                        None
                    } else {
                        Some(text)
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(p)) => {
                    let _ = w.send(Message::Pong(p));
                    None
                }
                Ok(_) => None,
                Err(tungstenite::Error::Io(ref e))
                    if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut =>
                {
                    None
                }
                Err(_) => break,
            }
        };
        let Some(text) = msg else { continue };

        let parsed: serde_json::Value = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => break,
        };
        let ty = parsed["type"].as_str().unwrap_or("");
        if !paired && ty != "pair" && ty != "ping" {
            break; // must pair first
        }
        match ty {
            "pair" => {
                // Locked out? Reject before even looking at the code.
                {
                    let mut lock = PAIR_LOCKED_UNTIL.lock().unwrap();
                    if let Some(until) = *lock {
                        if Instant::now() < until {
                            drop(lock);
                            let mut w = ws.lock().unwrap();
                            let _ = w.send(Message::Text(
                                json!({"type": "pair-error", "error": "too many failed attempts — try again in a minute"}).to_string(),
                            ));
                            break;
                        }
                        *lock = None; // lockout expired
                    }
                }
                let state = app.state::<AppState>();
                let expected = state.pair_code.lock().unwrap().clone();
                if parsed["code"].as_str() == Some(expected.as_str()) {
                    PAIR_FAILURES.store(0, Ordering::SeqCst);
                    paired = true;
                    state.ws_connected.store(true, Ordering::SeqCst);
                    *state.ws_tx.lock().unwrap() = Some(ws.clone());
                    // The web AI is reachable: mark it active for failover.
                    state
                        .failover
                        .lock()
                        .unwrap()
                        .record_activity(crate::failover::Agent::Web, "pair");
                    let _ = app.emit("pair://status", true);
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(
                        json!({
                            "type": "pair-ok",
                            "proto": PROTOCOL_VERSION,
                            "server_version": SERVER_VERSION,
                        })
                        .to_string(),
                    ));
                    eprintln!("[ws] extension paired (proto={PROTOCOL_VERSION})");
                } else {
                    // Count the failure and maybe lock pairing out. The
                    // sleep slows each guess; the lockout stops a
                    // determined brute force outright.
                    let fails = PAIR_FAILURES.fetch_add(1, Ordering::SeqCst) + 1;
                    if fails >= MAX_PAIR_FAILURES {
                        *PAIR_LOCKED_UNTIL.lock().unwrap() =
                            Some(Instant::now() + PAIR_LOCKOUT);
                        PAIR_FAILURES.store(0, Ordering::SeqCst);
                        eprintln!("[ws] pairing locked for {PAIR_LOCKOUT:?} after {fails} failed attempts");
                    }
                    std::thread::sleep(PAIR_FAIL_DELAY);
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(
                        json!({"type": "pair-error", "error": "invalid code"}).to_string(),
                    ));
                    break;
                }
            }
            "ping" => {
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(json!({"type": "pong"}).to_string()));
            }

            // ── Protocol v2: tool_call ──────────────────────────────
            "tool_call" => {
                let id = parsed["id"].as_str().unwrap_or("");
                let tool_name = parsed["tool"].as_str().unwrap_or("");
                let args = &parsed["arguments"];

                let tool = match parse_tool_call_v2(tool_name, args) {
                    Ok(t) => t,
                    Err(e) => {
                        let mut w = ws.lock().unwrap();
                        let _ = w.send(Message::Text(make_tool_result_v2(
                            id,
                            "error",
                            None,
                            Some(json!({"code": "INVALID_ARGUMENTS", "message": e})),
                            None,
                        )));
                        continue;
                    }
                };

                // Server-side idempotency: the extension retries a timed-
                // out call with the same id — if that id already reached
                // execution, refuse the duplicate instead of running e.g.
                // `write_file` twice.
                let already_ran = {
                    let state = app.state::<AppState>();
                    crate::db::audit_has_request(&state.conn.lock().unwrap(), id)
                        .unwrap_or(false)
                };
                if already_ran {
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(make_tool_result_v2(
                        id,
                        "error",
                        None,
                        Some(json!({
                            "code": "DUPLICATE_REQUEST",
                            "message": "this request id was already executed; not running it twice",
                        })),
                        None,
                    )));
                    continue;
                }

                let ws = ws.clone();
                let app = app.clone();
                let id = id.to_string();
                std::thread::spawn(move || {
                    // Mark this thread's execution as owned by the request,
                    // so approvals and spawned processes point back at it.
                    crate::bridge::set_execution_owner(Some(id.clone()));
                    let result = crate::tool_call(&app, tool.clone(), "web", Some(&id));
                    crate::bridge::set_execution_owner(None);
                    let meta = tool_meta(&tool);
                    let (status, result_val, error_val) = if result.ok {
                        (
                            "success".to_string(),
                            json!({"output": result.output, "bytes": result.output.as_ref().map(|s| s.len())}),
                            serde_json::Value::Null,
                        )
                    } else if result.pending.is_some() {
                        (
                            "pending".to_string(),
                            json!({"summary": result.pending}),
                            serde_json::Value::Null,
                        )
                    } else {
                        (
                            "error".to_string(),
                            serde_json::Value::Null,
                            json!({"code": "EXECUTION_FAILED", "message": result.error.unwrap_or_default()}),
                        )
                    };
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(make_tool_result_v2(
                        &id,
                        &status,
                        Some(result_val),
                        Some(error_val),
                        Some(meta),
                    )));
                });
            }

            // ── Protocol v2: tool_approve ───────────────────────────
            // Deliberately inert: approvals resolve only in the desktop
            // UI. The extension's Allow/Deny buttons used to live in the
            // host page's DOM, where any page script could approve via a
            // synthetic `.click()`, so the WS path that executed these
            // was removed. Reply with an error so a stale extension gets
            // a clear message instead of a dropped connection.
            "tool_approve" => {
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(make_tool_result_v2(
                    parsed["id"].as_str().unwrap_or(""),
                    "error",
                    None,
                    Some(json!({
                        "code": "APPROVAL_DESKTOP_ONLY",
                        "message": "approvals are handled in the desktop app",
                    })),
                    None,
                )));
            }

            // ── Legacy v1: tool ─────────────────────────────────────
            "tool" => {
                let id = parsed["id"].as_u64().unwrap_or(0);
                let tool: crate::bridge::Tool = match serde_json::from_value(parsed["tool"].clone())
                {
                    Ok(t) => t,
                    Err(e) => {
                        let mut w = ws.lock().unwrap();
                        let _ = w.send(Message::Text(make_tool_result_v1(
                            id,
                            &crate::bridge::ToolResult::err(format!("bad tool payload: {e}")),
                        )));
                        continue;
                    }
                };
                let ws = ws.clone();
                let app = app.clone();
                std::thread::spawn(move || {
                    let result = crate::tool_call(&app, tool, "web", None);
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(make_tool_result_v1(id, &result)));
                });
            }

            // ── Legacy v1: approve ──────────────────────────────────
            // Inert for the same reason as v2's tool_approve above.
            "approve" => {
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(make_tool_result_v1(
                    parsed["id"].as_u64().unwrap_or(0),
                    &crate::bridge::ToolResult::err("approvals are handled in the desktop app"),
                )));
            }

            "handoff-request" => {
                let state = app.state::<AppState>();
                match crate::build_handoff_impl(&state) {
                    Ok(handoff) => {
                        let mut w = ws.lock().unwrap();
                        let _ = w.send(Message::Text(
                            json!({"type": "handoff", "payload": handoff}).to_string(),
                        ));
                    }
                    Err(e) => {
                        let mut w = ws.lock().unwrap();
                        let _ = w.send(Message::Text(
                            json!({"type": "handoff-error", "error": e}).to_string(),
                        ));
                    }
                }
            }
            // ── Protocol v2: cancel ─────────────────────────────────
            // Stop the processes owned by a request and unblock its
            // approval wait. Previously the catch-all below *dropped the
            // connection* on cancel — the running command kept going.
            "cancel" => {
                let id = parsed["id"].as_str().unwrap_or("");
                let killed = if id.is_empty() {
                    0
                } else {
                    crate::process::registry().kill_task(id, std::time::Duration::from_millis(500))
                };
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(
                    json!({"type": "cancel-ok", "id": id, "killed": killed}).to_string(),
                ));
            }

            // ── lexsus-agent/1: task frames ─────────────────────────
            // The extension (or any paired client) can create and steer
            // tasks; state transitions are validated and persisted, so a
            // restart sees exactly where each task stopped.
            "task_create" => {
                let req_id = parsed["id"].as_str().unwrap_or("").to_string();
                let title = parsed["title"].as_str().unwrap_or("Web task").to_string();
                let objective = parsed["objective"].as_str().unwrap_or("").to_string();
                let reply = {
                    let state = app.state::<AppState>();
                    crate::task::create_task(
                        &state.conn.lock().unwrap(),
                        &title,
                        &objective,
                        "web",
                        None,
                    )
                };
                let mut w = ws.lock().unwrap();
                let msg = match reply {
                    Ok(t) => json!({"type": "task_result", "id": req_id, "ok": true, "task": t}),
                    Err(e) => json!({"type": "task_result", "id": req_id, "ok": false, "error": e.to_string()}),
                };
                let _ = w.send(Message::Text(msg.to_string()));
            }

            "task_status" => {
                let req_id = parsed["id"].as_str().unwrap_or("").to_string();
                let task_id = parsed["task_id"].as_str().unwrap_or("");
                let reply = {
                    let state = app.state::<AppState>();
                    crate::task::get_task(&state.conn.lock().unwrap(), task_id)
                };
                let mut w = ws.lock().unwrap();
                let msg = match reply {
                    Ok(t) => json!({"type": "task_result", "id": req_id, "ok": true, "task": t}),
                    Err(e) => json!({"type": "task_result", "id": req_id, "ok": false, "error": e.to_string()}),
                };
                let _ = w.send(Message::Text(msg.to_string()));
            }

            "task_pause" | "task_resume" | "task_cancel" => {
                let req_id = parsed["id"].as_str().unwrap_or("").to_string();
                let task_id = parsed["task_id"].as_str().unwrap_or("").to_string();
                let to = match ty {
                    "task_pause" => crate::task::TaskState::Paused,
                    "task_resume" => crate::task::TaskState::Executing,
                    _ => {
                        // Cancellation: stop owned processes first, then
                        // walk the machine through `cancelling`.
                        crate::process::registry()
                            .kill_task(&task_id, std::time::Duration::from_millis(500));
                        let state = app.state::<AppState>();
                        let _ = crate::task::transition(
                            &state.conn.lock().unwrap(),
                            &task_id,
                            crate::task::TaskState::Cancelling,
                            "cancel requested over ws",
                        );
                        crate::task::TaskState::Cancelled
                    }
                };
                let reply = {
                    let state = app.state::<AppState>();
                    crate::task::transition(
                        &state.conn.lock().unwrap(),
                        &task_id,
                        to,
                        &format!("{ty} over ws"),
                    )
                };
                let mut w = ws.lock().unwrap();
                let msg = match reply {
                    Ok(t) => json!({"type": "task_result", "id": req_id, "ok": true, "task": t}),
                    Err(e) => json!({"type": "task_result", "id": req_id, "ok": false, "error": e.to_string()}),
                };
                let _ = w.send(Message::Text(msg.to_string()));
            }

            // ── MCP: dynamic tool list for the extension ────────────
            // The extension registers these as namespaced tools
            // (`mcp__server__tool`) so a web AI can call them directly.
            "mcp_tools" => {
                let tools = crate::mcp::manager().list_tools();
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(
                    json!({"type": "mcp_tools", "tools": tools}).to_string(),
                ));
            }

            // Unknown frames get a clear error instead of a dropped
            // connection — a typo must not kill the session.
            other => {
                eprintln!("[ws] unknown frame type: {other}");
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(
                    json!({
                        "type": "error",
                        "error": format!("unknown frame type: {other}"),
                    })
                    .to_string(),
                ));
            }
        }
    }

    let state = app.state::<AppState>();
    state.ws_connected.store(false, Ordering::SeqCst);
    state.ws_tx.lock().unwrap().take();
    let _ = app.emit("pair://status", false);
    eprintln!("[ws] extension disconnected");
}

/// Push a handoff payload to the paired extension (no-op when absent).
pub fn push_handoff(app: &AppHandle, payload: &serde_json::Value) -> bool {
    let state = app.state::<AppState>();
    if !state.ws_connected.load(Ordering::SeqCst) {
        return false;
    }
    let guard = state.ws_tx.lock().unwrap();
    match guard.as_ref() {
        Some(ws) => {
            let msg = json!({"type": "handoff", "payload": payload}).to_string();
            ws.lock().unwrap().send(Message::Text(msg)).is_ok()
        }
        None => false,
    }
}

/// Send an arbitrary JSON message to the paired extension.
pub fn send(app: &AppHandle, msg: serde_json::Value) -> bool {
    let state = app.state::<AppState>();
    if !state.ws_connected.load(Ordering::SeqCst) {
        return false;
    }
    let guard = state.ws_tx.lock().unwrap();
    match guard.as_ref() {
        Some(ws) => ws
            .lock()
            .unwrap()
            .send(Message::Text(msg.to_string()))
            .is_ok(),
        None => false,
    }
}
