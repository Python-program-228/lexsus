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
//!   ext → app: {"type":"tool_approve","id":"<uuid>","allow":true}
//!   ext → app: {"type":"ping"} → {"type":"pong"}
//!   app → ext: {"type":"handoff","payload":{...}}  (pushed)
//!
//! Protocol v1 (legacy, still accepted):
//!   ext → app: {"type":"tool","id":1,"tool":{"ReadFile":{"path":"..."}}}
//!   app → ext: {"type":"tool-result","id":1,"result":{...}}
//!   ext → app: {"type":"approve","id":1,"allow":true}

use crate::AppState;
use serde_json::json;
use std::io::ErrorKind;
use std::net::TcpListener;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tungstenite::protocol::Message;

pub const ADDR: &str = "127.0.0.1:45241";
pub const PROTOCOL_VERSION: u32 = 2;
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Generate a fresh 6-digit pairing code.
pub fn new_pair_code() -> String {
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let code = (seed % 900_000 + 100_000) as u32;
    format!("{code:06}")
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

/// Extract the tool name and arguments from a v1 Tool enum for v2 response metadata.
fn tool_meta(tool: &crate::bridge::Tool) -> serde_json::Value {
    match tool {
        crate::bridge::Tool::ReadFile { path } => json!({"tool": "read_file", "path": path}),
        crate::bridge::Tool::WriteFile { path, .. } => json!({"tool": "write_file", "path": path}),
        crate::bridge::Tool::RunCommand { command } => json!({"tool": "run_command", "command": command}),
        crate::bridge::Tool::ListDirectory { path } => json!({"tool": "list_directory", "path": path}),
        crate::bridge::Tool::GitStatus => json!({"tool": "git_status"}),
    }
}

/// Parse a v2 tool_call message into a Tool enum.
fn parse_tool_call_v2(tool_name: &str, args: &serde_json::Value) -> Result<crate::bridge::Tool, String> {
    match tool_name {
        "read_file" => {
            let path = args["path"].as_str().ok_or("missing 'path' argument")?;
            Ok(crate::bridge::Tool::ReadFile { path: path.to_string() })
        }
        "write_file" => {
            let path = args["path"].as_str().ok_or("missing 'path' argument")?;
            let content = args["content"].as_str().ok_or("missing 'content' argument")?;
            Ok(crate::bridge::Tool::WriteFile {
                path: path.to_string(),
                content: content.to_string(),
            })
        }
        "run_command" => {
            let command = args["command"].as_str().ok_or("missing 'command' argument")?;
            Ok(crate::bridge::Tool::RunCommand { command: command.to_string() })
        }
        "list_directory" => {
            let path = args["path"].as_str().ok_or("missing 'path' argument")?;
            Ok(crate::bridge::Tool::ListDirectory { path: path.to_string() })
        }
        "git_status" => Ok(crate::bridge::Tool::GitStatus),
        _ => Err(format!("unknown tool: {tool_name}")),
    }
}

fn handle_conn(app: AppHandle, stream: std::net::TcpStream) {
    stream
        .set_read_timeout(Some(Duration::from_millis(100)))
        .ok();
    let ws = match tungstenite::accept(stream) {
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
                Ok(Message::Text(text)) => Some(text),
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
                let state = app.state::<AppState>();
                let expected = state.pair_code.lock().unwrap().clone();
                if parsed["code"].as_str() == Some(expected.as_str()) {
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
                        let _ = w.send(Message::Text(
                            make_tool_result_v2(
                                id,
                                "error",
                                None,
                                Some(json!({"code": "INVALID_ARGUMENTS", "message": e})),
                                None,
                            ),
                        ));
                        continue;
                    }
                };

                let ws = ws.clone();
                let app = app.clone();
                let id = id.to_string();
                std::thread::spawn(move || {
                    let result = crate::tool_call(&app, tool.clone(), "web");
                    let meta = tool_meta(&tool);
                    let (status, result_val, error_val) = if result.ok {
                        ("success".to_string(), json!({"output": result.output, "bytes": result.output.as_ref().map(|s| s.len())}), serde_json::Value::Null)
                    } else if result.pending.is_some() {
                        ("pending".to_string(), json!({"summary": result.pending}), serde_json::Value::Null)
                    } else {
                        ("error".to_string(), serde_json::Value::Null, json!({"code": "EXECUTION_FAILED", "message": result.error.unwrap_or_default()}))
                    };
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(
                        make_tool_result_v2(&id, &status, Some(result_val), Some(error_val), Some(meta)),
                    ));
                });
            }

            // ── Protocol v2: tool_approve ───────────────────────────
            "tool_approve" => {
                let id_str = parsed["id"].as_str().unwrap_or("");
                let allow = parsed["allow"].as_bool().unwrap_or(false);
                let state = app.state::<AppState>();
                let root = state.project_root.lock().unwrap().clone();
                let mut stream = crate::command_stream(&app);

                // Try to resolve by string ID first, then by parsed u64
                let id_num: u64 = id_str.parse().unwrap_or(0);
                let outcome = state.bridge.lock().unwrap().resolve(
                    id_num,
                    allow,
                    root.as_deref(),
                    Some(&mut stream),
                );

                let result = match outcome {
                    Some((result, req)) => {
                        let _ = crate::db::record_audit(
                            &state.conn.lock().unwrap(),
                            &req.source,
                            "tool",
                            &serde_json::json!(req.tool).to_string(),
                            allow,
                            if allow { "user" } else { "denied" },
                            result.ok,
                        );
                        if allow && result.ok {
                            crate::record_tool_trace(&state, &app, &req.tool);
                        }
                        let _ = app.emit(
                            "bridge://approval-resolved",
                            json!({"id": id_str, "allowed": allow, "result": result}),
                        );
                        result
                    }
                    None => crate::bridge::ToolResult {
                        ok: false,
                        output: None,
                        error: Some("unknown approval id".into()),
                        error_code: None,
                        pending: None,
                    },
                };

                let meta = None;
                let (status, result_val, error_val) = if result.ok {
                    ("success".to_string(), json!({"output": result.output}), serde_json::Value::Null)
                } else if !allow {
                    ("denied".to_string(), serde_json::Value::Null, json!({"code": "DENIED", "message": result.error.unwrap_or_default()}))
                } else {
                    ("error".to_string(), serde_json::Value::Null, json!({"code": "EXECUTION_FAILED", "message": result.error.unwrap_or_default()}))
                };
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(
                    make_tool_result_v2(id_str, &status, Some(result_val), Some(error_val), meta),
                ));
            }

            // ── Legacy v1: tool ─────────────────────────────────────
            "tool" => {
                let id = parsed["id"].as_u64().unwrap_or(0);
                let tool: crate::bridge::Tool = match serde_json::from_value(parsed["tool"].clone())
                {
                    Ok(t) => t,
                    Err(e) => {
                        let mut w = ws.lock().unwrap();
                        let _ = w.send(Message::Text(
                            make_tool_result_v1(
                                id,
                                &crate::bridge::ToolResult::err(format!("bad tool payload: {e}")),
                            ),
                        ));
                        continue;
                    }
                };
                let ws = ws.clone();
                let app = app.clone();
                std::thread::spawn(move || {
                    let result = crate::tool_call(&app, tool, "web");
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(make_tool_result_v1(id, &result)));
                });
            }

            // ── Legacy v1: approve ──────────────────────────────────
            "approve" => {
                let id = parsed["id"].as_u64().unwrap_or(0);
                let allow = parsed["allow"].as_bool().unwrap_or(false);
                let state = app.state::<AppState>();
                let root = state.project_root.lock().unwrap().clone();
                let mut stream = crate::command_stream(&app);
                let outcome = state.bridge.lock().unwrap().resolve(
                    id,
                    allow,
                    root.as_deref(),
                    Some(&mut stream),
                );
                let result = match outcome {
                    Some((result, req)) => {
                        let _ = crate::db::record_audit(
                            &state.conn.lock().unwrap(),
                            &req.source,
                            "tool",
                            &serde_json::json!(req.tool).to_string(),
                            allow,
                            if allow { "user" } else { "denied" },
                            result.ok,
                        );
                        if allow && result.ok {
                            crate::record_tool_trace(&state, &app, &req.tool);
                        }
                        let _ = app.emit(
                            "bridge://approval-resolved",
                            json!({"id": id, "allowed": allow, "result": result}),
                        );
                        result
                    }
                    None => crate::bridge::ToolResult {
                        ok: false,
                        output: None,
                        error: Some("unknown approval id".into()),
                        error_code: None,
                        pending: None,
                    },
                };
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(make_tool_result_v1(id, &result)));
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
            _ => break,
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
