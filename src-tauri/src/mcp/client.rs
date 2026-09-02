//! A hardened stdio JSON-RPC client for one MCP server process.
//!
//! Based on the original `client.rs` draft, with the reliability gaps
//! closed:
//!
//!   * **Timeouts.** Replies are read on a dedicated reader thread and
//!     delivered over a channel, so `request` waits with `recv_timeout`
//!     instead of blocking on `read_line` forever — a hung server can no
//!     longer freeze the bridge.
//!   * **Death detection.** When the reader thread hits EOF it exits and
//!     drops its sender; pending and future requests fail fast with
//!     "MCP server died" and the manager evicts the client.
//!   * **stderr is drained**, not inherited, so a chatty server cannot
//!     block on a full pipe (and its logs reach our log instead of the
//!     Tauri console).
//!   * **PATH augmentation.** macOS GUI apps get a minimal PATH without
//!     Homebrew/nvm — spawn prepends the usual locations so `npx`, `uvx`
//!     & co. resolve the same way they do in a terminal.
//!   * **Own process group** (unix): the child is a process-group leader,
//!     so the process registry can kill the whole tree (server + anything
//!     it spawned) with one signal.
//!   * **Drop kills the child** — closing the app never orphans servers.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::Duration;

/// Default per-request timeout. MCP tool calls (e.g. GUI automation) can
/// be slow, but 60 s is long enough for anything legitimate; a server that
/// needs longer is hung as far as the runtime is concerned.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Directories a macOS *terminal* would have on PATH but a GUI app does
/// not. Prepended (not appended) so Homebrew wins over system stubs.
#[cfg(target_os = "macos")]
const GUI_PATH_PREFIX: &str = "/opt/homebrew/bin:/usr/local/bin";

/// Build a PATH for child processes that works from a GUI-launched app.
fn child_path() -> Option<String> {
    let current = std::env::var("PATH").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        Some(format!("{GUI_PATH_PREFIX}:{current}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        if current.is_empty() {
            None
        } else {
            Some(current)
        }
    }
}

pub struct McpClient {
    /// Kept so `Drop` can kill the child; locked only there.
    child: Mutex<Child>,
    /// Option so `Drop` can close the pipe (EOF → graceful server exit).
    stdin: Mutex<Option<ChildStdin>>,
    /// Lines from the server, delivered by the reader thread.
    inbox: Mutex<Receiver<String>>,
    next_id: AtomicU64,
    dead: AtomicBool,
    timeout: Duration,
}

impl McpClient {
    /// Spawn a server process and start its reader/stderr-drain threads.
    /// `env` adds/overrides environment variables (from `mcp.json`).
    pub fn spawn(
        cmd: &str,
        args: &[String],
        env: &[(String, String)],
        timeout: Option<Duration>,
    ) -> Result<Self, String> {
        let mut command = Command::new(cmd);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = child_path() {
            command.env("PATH", path);
        }
        for (k, v) in env {
            command.env(k, v);
        }
        // Own process group so the registry can kill the whole tree.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to spawn MCP server '{cmd}': {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP server stdout unavailable".to_string())?;
        let stderr = child.stderr.take();

        // Reader thread: stdout lines → channel. On EOF the thread exits,
        // the sender drops, and receivers observe a disconnect (death).
        let (tx, rx) = channel::<String>();
        let cmd_name = cmd.to_string();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,        // EOF: server exited
                    Ok(_) => {
                        if tx.send(line.clone()).is_err() {
                            break; // client dropped
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Drain stderr so a loggy server never blocks on a full pipe.
        if let Some(err) = stderr {
            let cmd_name2 = cmd_name.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(err);
                for line in reader.lines() {
                    match line {
                        Ok(l) => eprintln!("[mcp:{cmd_name2}] {l}"),
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(Some(stdin)),
            inbox: Mutex::new(rx),
            next_id: AtomicU64::new(1),
            dead: AtomicBool::new(false),
            timeout: timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT),
        })
    }

    /// The OS process id, for the process registry.
    pub fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }

    /// Has the server died (EOF / broken pipe)?
    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }

    fn mark_dead(&self) {
        self.dead.store(true, Ordering::SeqCst);
    }

    fn write_line(&self, text: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
        let Some(stdin) = guard.as_mut() else {
            return Err("MCP server stdin is closed".to_string());
        };
        stdin
            .write_all(text.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| {
                self.mark_dead();
                format!("MCP write failed: {e}")
            })
    }

    /// Send a JSON-RPC request and wait for its reply (bounded by
    /// `timeout`). Lines that are not our reply (notifications, replies
    /// to other ids) are skipped.
    pub fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.is_dead() {
            return Err("MCP server is dead".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        self.write_line(&format!("{}\n", req))?;

        let inbox = self.inbox.lock().unwrap();
        loop {
            match inbox.recv_timeout(self.timeout) {
                Ok(line) => {
                    let Ok(resp) = serde_json::from_str::<Value>(&line) else {
                        continue; // not JSON — server log noise on stdout
                    };
                    if resp.get("id").and_then(|i| i.as_u64()) != Some(id) {
                        continue; // notification or someone else's reply
                    }
                    if let Some(err) = resp.get("error") {
                        return Err(format!("MCP error: {err}"));
                    }
                    return Ok(resp.get("result").cloned().unwrap_or(Value::Null));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "MCP request '{method}' timed out after {}s",
                        self.timeout.as_secs()
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.mark_dead();
                    return Err("MCP server died (EOF on stdout)".to_string());
                }
            }
        }
    }

    /// MCP handshake: `initialize` + `notifications/initialized`.
    pub fn initialize(&self) -> Result<(), String> {
        let init_req = json!({
            "protocolVersion": "2024-11-05",
            "clientInfo": {
                "name": "lexsus",
                "version": "0.1.0"
            },
            "capabilities": {}
        });
        self.request("initialize", init_req)?;

        let notif = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        self.write_line(&format!("{}\n", notif))?;
        Ok(())
    }

    pub fn list_tools(&self) -> Result<Value, String> {
        self.request("tools/list", json!({}))
    }

    pub fn call_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        self.request(
            "tools/call",
            json!({
                "name": name,
                "arguments": args
            }),
        )
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // SIGTERM equivalent: `Child::kill` sends SIGKILL on unix — too
        // blunt for a graceful shutdown, but by Drop time the server has
        // usually already exited (stdin closed). Try stdin close first by
        // dropping the pipe, then reap with a bounded wait.
        if let Ok(mut child) = self.child.lock() {
            // Close stdin first: a well-behaved server exits on EOF.
            let _ = self.stdin.lock().unwrap().take();
            // Give the server a moment to exit on its own.
            for _ in 0..10 {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
