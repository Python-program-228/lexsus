//! Local WebSocket server (M2): the browser extension pairs with the
//! desktop app over `ws://127.0.0.1:45241` using a 6-digit pairing code,
//! then relays web-AI tool calls and receives handoffs.
//!
//! Loopback-only, no TLS: the endpoint is bound to 127.0.0.1 and the
//! pairing code gates every connection. Protocol (JSON):
//!   ext → app: {"type":"pair","code":"123456"}
//!   app → ext: {"type":"pair-ok"}
//!   ext → app: {"type":"tool","id":1,"tool":{"ReadFile":{"path":"..."}}}
//!   app → ext: {"type":"tool-result","id":1,"result":{...}}
//!   ext → app: {"type":"ping"} → {"type":"pong"}
//!   app → ext: {"type":"handoff","payload":{...}}  (pushed)

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
                    let _ = w.send(Message::Text(json!({"type": "pair-ok"}).to_string()));
                    eprintln!("[ws] extension paired");
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
            "tool" => {
                let id = parsed["id"].as_u64().unwrap_or(0);
                let tool: crate::bridge::Tool = match serde_json::from_value(parsed["tool"].clone())
                {
                    Ok(t) => t,
                    Err(e) => {
                        let mut w = ws.lock().unwrap();
                        let _ = w.send(Message::Text(
                            json!({"type": "tool-result", "id": id, "result": {
                                "ok": false,
                                "output": null,
                                "error": format!("bad tool payload: {e}"),
                                "pending": null
                            }})
                            .to_string(),
                        ));
                        continue;
                    }
                };
                // Run on a separate thread so the connection stays free to
                // receive the extension's approval decision while a tool
                // call waits for it.
                let ws = ws.clone();
                let app = app.clone();
                std::thread::spawn(move || {
                    let result = crate::tool_call(&app, tool, "web");
                    let mut w = ws.lock().unwrap();
                    let _ = w.send(Message::Text(
                        json!({"type": "tool-result", "id": id, "result": result}).to_string(),
                    ));
                });
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
                        pending: None,
                    },
                };
                let mut w = ws.lock().unwrap();
                let _ = w.send(Message::Text(
                    json!({"type": "tool-result", "id": id, "result": result}).to_string(),
                ));
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
