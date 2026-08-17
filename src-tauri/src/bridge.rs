//! The web-AI coding-agent bridge (M2).
//!
//! Tool calls arrive from the browser extension (over the local
//! WebSocket), from the desktop tool sandbox, or from the frontend's
//! handoff flow. Every call is policy-checked: reads are auto-approved
//! (except sensitive paths), writes and command execution always require
//! an explicit user approval. All calls are audited to SQLite.

use crate::{git, pty, shell::Shell};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Mutex;
use std::time::Duration;

/// A web-AI tool call (serde: externally-tagged, mirrors `types.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Tool {
    ReadFile { path: String },
    WriteFile { path: String, content: String },
    RunCommand { command: String },
    ListDirectory { path: String },
    GitStatus,
}

/// A streaming event for a running command. Mirrors the `terminal://run`
/// event the UI renders.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CommandEvent {
    Start {
        command: String,
    },
    Output {
        data: String,
    },
    Exit {
        code: Option<i32>,
        timed_out: bool,
        truncated: bool,
    },
}

/// Result of a tool call. `pending` is set when the call awaits an
/// explicit user approval (the caller should wait for resolution).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: Option<String>,
    pub error: Option<String>,
    pub pending: Option<String>,
}

impl ToolResult {
    pub fn ok(output: String) -> Self {
        Self {
            ok: true,
            output: Some(output),
            error: None,
            pending: None,
        }
    }
    pub fn err<S: Into<String>>(error: S) -> Self {
        Self {
            ok: false,
            output: None,
            error: Some(error.into()),
            pending: None,
        }
    }
    pub fn pending<S: Into<String>>(summary: S) -> Self {
        Self {
            ok: false,
            output: None,
            error: None,
            pending: Some(summary.into()),
        }
    }
}

/// A queued approval request shown to the user.
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub id: u64,
    pub tool: Tool,
    pub summary: String,
    pub source: String, // web | desktop
}

/// Bridge state shared via AppState.
#[derive(Default)]
pub struct Bridge {
    pub pending: Mutex<Vec<ApprovalRequest>>,
    /// WS callers waiting for approval resolution, keyed by request id.
    pub channels: Mutex<HashMap<u64, SyncSender<ToolResult>>>,
    pub next_id: AtomicU64,
}

impl Bridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Route a tool call: auto-execute or queue for approval.
    /// Returns `(result, approval_id)` — if the call needs approval,
    /// `result.pending` is set and `approval_id` is the id to resolve.
    pub fn submit(
        &self,
        tool: Tool,
        source: &str,
        root: Option<&Path>,
    ) -> (ToolResult, Option<u64>) {
        match needs_approval(&tool) {
            None => (execute(&tool, root, None), None),
            Some(reason) => {
                let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
                self.pending.lock().unwrap().push(ApprovalRequest {
                    id,
                    summary: describe(&tool),
                    tool,
                    source: source.to_string(),
                });
                (
                    ToolResult::pending(format!("{reason} (request #{id})")),
                    Some(id),
                )
            }
        }
    }

    /// Resolve a pending approval. Executes the tool when allowed,
    /// delivers the result to any waiting WS caller, and returns the
    /// result plus the resolved request (for auditing). `on_event`
    /// receives command stream events while a `run_command` executes.
    pub fn resolve(
        &self,
        id: u64,
        allow: bool,
        root: Option<&Path>,
        on_event: Option<&mut dyn FnMut(CommandEvent)>,
    ) -> Option<(ToolResult, ApprovalRequest)> {
        let mut pending = self.pending.lock().unwrap();
        let idx = pending.iter().position(|p| p.id == id)?;
        let req = pending.remove(idx);
        drop(pending);

        let result = if allow {
            execute(&req.tool, root, on_event)
        } else {
            ToolResult::err(format!("denied by user: {}", req.summary))
        };

        if let Some(tx) = self.channels.lock().unwrap().remove(&id) {
            let _ = tx.send(result.clone());
        }
        Some((result, req))
    }
}

/// Human-readable summary of a tool call (for the approval UI + audit).
pub fn describe(tool: &Tool) -> String {
    match tool {
        Tool::ReadFile { path } => format!("read_file {path}"),
        Tool::WriteFile { path, content } => {
            format!("write_file {path} ({} bytes)", content.len())
        }
        Tool::RunCommand { command } => format!("run_command: {command}"),
        Tool::ListDirectory { path } => format!("list_directory {path}"),
        Tool::GitStatus => "git_status".to_string(),
    }
}

/// Paths that always require explicit approval, even for reads.
pub fn is_sensitive_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let lower = path.to_string_lossy().to_lowercase();
    if name.starts_with(".env") {
        return true;
    }
    for needle in [
        "id_rsa",
        "id_dsa",
        "credentials",
        "secret",
        "token",
        "password",
        "api_key",
        "apikey",
        ".npmrc",
        ".gitconfig",
        ".netrc",
    ] {
        if name.contains(needle) {
            return true;
        }
    }
    for ext in ["pem", "key", "pfx", "p12", "ppk", "crt"] {
        if path
            .extension()
            .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case(ext))
        {
            return true;
        }
    }
    // .git internals (config, credentials) are off-limits to reads.
    lower.contains(".git\\config") || lower.contains(".git/config")
}

/// Approval policy: `Some(reason)` when the call needs user approval.
pub fn needs_approval(tool: &Tool) -> Option<String> {
    match tool {
        Tool::ReadFile { path } => {
            if is_sensitive_path(Path::new(path)) {
                Some("read of sensitive path".to_string())
            } else {
                None
            }
        }
        Tool::WriteFile { .. } => Some("write_file".to_string()),
        Tool::RunCommand { .. } => Some("run_command".to_string()),
        Tool::ListDirectory { .. } | Tool::GitStatus => None,
    }
}

const READ_CAP: u64 = 512 * 1024;

/// Resolve a tool path against the project root; rejects paths escaping it.
fn resolve_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let candidate = root.join(rel);
    let canonical = if candidate.exists() {
        candidate.canonicalize().map_err(|e| e.to_string())?
    } else {
        // The target may not exist yet (write_file to a new file):
        // canonicalize the deepest existing ancestor instead.
        let mut parent = candidate.parent().unwrap_or(&root).to_path_buf();
        while !parent.exists() {
            if !parent.pop() {
                break;
            }
        }
        parent
            .canonicalize()
            .map(|p| p.join(rel.trim_start_matches(['\\', '/'])))
            .map_err(|e| e.to_string())?
    };
    if !canonical.starts_with(&root) {
        return Err(format!("path escapes project root: {rel}"));
    }
    Ok(canonical)
}

/// Execute a tool call locally. `root: None` → tool requires the root.
/// `on_event` streams command events while a `run_command` executes.
pub fn execute(
    tool: &Tool,
    root: Option<&Path>,
    mut on_event: Option<&mut dyn FnMut(CommandEvent)>,
) -> ToolResult {
    let Some(root) = root else {
        return ToolResult::err("project root not set".to_string());
    };

    match tool {
        Tool::ReadFile { path } => {
            let p = match resolve_path(root, path) {
                Ok(p) => p,
                Err(e) => return ToolResult::err(e),
            };
            match std::fs::metadata(&p) {
                Ok(md) if md.is_dir() => {
                    return ToolResult::err(format!("is a directory: {path}"));
                }
                Err(e) => return ToolResult::err(format!("{path}: {e}")),
                _ => {}
            }
            match std::fs::read(&p) {
                Ok(bytes) => {
                    if bytes.contains(&0) {
                        return ToolResult::ok(format!(
                            "{}: binary file ({} bytes, not shown)",
                            path,
                            bytes.len()
                        ));
                    }
                    if bytes.len() as u64 > READ_CAP {
                        return ToolResult::err(format!(
                            "{path}: file too large ({})",
                            bytes.len()
                        ));
                    }
                    ToolResult::ok(String::from_utf8_lossy(&bytes).into_owned())
                }
                Err(e) => ToolResult::err(format!("{path}: {e}")),
            }
        }
        Tool::WriteFile { path, content } => {
            let p = match resolve_path(root, path) {
                Ok(p) => p,
                Err(e) => return ToolResult::err(e),
            };
            if let Some(parent) = p.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return ToolResult::err(format!("{path}: {e}"));
                }
            }
            match std::fs::write(&p, content.as_bytes()) {
                Ok(()) => ToolResult::ok(format!("wrote {} bytes to {path}", content.len())),
                Err(e) => ToolResult::err(format!("{path}: {e}")),
            }
        }
        Tool::RunCommand { command } => {
            if let Some(cb) = on_event.as_mut() {
                cb(CommandEvent::Start {
                    command: command.clone(),
                });
            }
            let out = {
                let mut forward = |chunk: String| {
                    if let Some(cb) = on_event.as_mut() {
                        cb(CommandEvent::Output { data: chunk });
                    }
                };
                pty::run_command_stream(
                    Shell::detect(),
                    command,
                    root,
                    Duration::from_secs(120),
                    1_048_576,
                    &mut forward,
                )
            };
            let out = match out {
                Ok(o) => o,
                Err(e) => {
                    if let Some(cb) = on_event.as_mut() {
                        cb(CommandEvent::Exit {
                            code: None,
                            timed_out: false,
                            truncated: false,
                        });
                    }
                    return ToolResult::err(format!("run_command failed: {e}"));
                }
            };
            if let Some(cb) = on_event.as_mut() {
                cb(CommandEvent::Exit {
                    code: out.exit_code,
                    timed_out: out.timed_out,
                    truncated: out.truncated,
                });
            }
            let mut text = out.output;
            if out.timed_out {
                text.push_str("\n[timed out — process killed]");
            }
            if out.truncated {
                text.push_str("\n[output truncated]");
            }
            text.push_str(&format!("\n[exit code: {}]", out.exit_code.unwrap_or(-1)));
            ToolResult::ok(text)
        }
        Tool::ListDirectory { path } => {
            let p = match resolve_path(root, path) {
                Ok(p) => p,
                Err(e) => return ToolResult::err(e),
            };
            let mut names = Vec::new();
            match std::fs::read_dir(&p) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        names.push(name);
                    }
                }
                Err(e) => return ToolResult::err(format!("{path}: {e}")),
            }
            names.sort();
            let mut out = format!("[{} entries]\n", names.len());
            out.push_str(&names.join("\n"));
            ToolResult::ok(out)
        }
        Tool::GitStatus => {
            let repo = match git::open_repo(root) {
                Ok(r) => r,
                Err(e) => return ToolResult::err(format!("not a git repo: {e}")),
            };
            let statuses = match git::status(&repo) {
                Ok(s) => s,
                Err(e) => return ToolResult::err(format!("git status: {e}")),
            };
            if statuses.is_empty() {
                return ToolResult::ok("working tree clean".to_string());
            }
            let mut out = format!("[{} changed files]\n", statuses.len());
            for s in statuses {
                out.push_str(&format!(
                    "{} [{} +{}/-{}]\n",
                    s.path, s.status, s.additions, s.deletions
                ));
            }
            ToolResult::ok(out)
        }
    }
}

/// Create a channel a WS caller can wait on for approval resolution.
pub fn wait_channel() -> (SyncSender<ToolResult>, Receiver<ToolResult>) {
    sync_channel(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sensitive_paths_are_detected() {
        for p in [
            ".env",
            ".env.local",
            "config/id_rsa",
            "certs/server.pem",
            "secrets.json",
            ".git/config",
            "credentials.txt",
            "api_key.txt",
        ] {
            assert!(is_sensitive_path(Path::new(p)), "{p} should be sensitive");
        }
        for p in ["src/main.ts", "README.md", "package.json", "docs/notes.txt"] {
            assert!(!is_sensitive_path(Path::new(p)), "{p} should be safe");
        }
    }

    #[test]
    fn approval_policy() {
        assert!(needs_approval(&Tool::ReadFile {
            path: "src/a.ts".into()
        })
        .is_none());
        assert!(needs_approval(&Tool::ReadFile {
            path: ".env".into()
        })
        .is_some());
        assert!(needs_approval(&Tool::WriteFile {
            path: "a.ts".into(),
            content: "x".into()
        })
        .is_some());
        assert!(needs_approval(&Tool::RunCommand {
            command: "echo hi".into()
        })
        .is_some());
        assert!(needs_approval(&Tool::ListDirectory { path: ".".into() }).is_none());
        assert!(needs_approval(&Tool::GitStatus).is_none());
    }

    #[test]
    fn resolve_path_rejects_escape() {
        let dir = std::env::temp_dir();
        assert!(resolve_path(&dir, "../outside").is_err());
        #[cfg(windows)]
        assert!(resolve_path(&dir, "..\\outside").is_err());
        assert!(resolve_path(&dir, "sub").is_ok());
    }

    #[test]
    fn execution_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bridge-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // write -> read roundtrip
        let r = execute(
            &Tool::WriteFile {
                path: "hello.txt".into(),
                content: "bridge hi".into(),
            },
            Some(&dir),
            None,
        );
        assert!(r.ok, "{:?}", r.error);
        let r = execute(
            &Tool::ReadFile {
                path: "hello.txt".into(),
            },
            Some(&dir),
            None,
        );
        assert!(r.ok);
        assert_eq!(r.output.as_deref(), Some("bridge hi"));

        // list directory
        let r = execute(&Tool::ListDirectory { path: ".".into() }, Some(&dir), None);
        assert!(r.ok);
        assert!(r.output.unwrap().contains("hello.txt"));

        // command
        let mut events = Vec::new();
        let r = execute(
            &Tool::RunCommand {
                command: "echo pty-ok".into(),
            },
            Some(&dir),
            Some(&mut |event| events.push(format!("{event:?}"))),
        );
        assert!(r.ok, "{:?}", r.error);
        assert!(r.output.unwrap().contains("pty-ok"));
        assert!(
            events.iter().any(|e| e.starts_with("Start")),
            "expected a Start event, got {events:?}"
        );
        assert!(
            events.iter().any(|e| e.starts_with("Exit")),
            "expected an Exit event, got {events:?}"
        );

        // escape rejected
        let r = execute(
            &Tool::ReadFile {
                path: "../../etc/hosts".into(),
            },
            Some(&dir),
            None,
        );
        assert!(!r.ok);

        // missing root
        assert!(!execute(&Tool::GitStatus, None, None).ok);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn approval_flow_resolves() {
        let dir = std::env::temp_dir().join(format!("bridge-approve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bridge = Bridge::new();

        let (result, id) = bridge.submit(
            Tool::RunCommand {
                command: "echo approved".into(),
            },
            "web",
            Some(&dir),
        );
        assert!(result.pending.is_some());
        let id = id.unwrap();

        let (tx, rx) = wait_channel();
        bridge.channels.lock().unwrap().insert(id, tx);

        let (r, req) = bridge.resolve(id, true, Some(&dir), None).unwrap();
        assert!(r.ok);
        assert_eq!(req.id, id);
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().ok);
        assert!(bridge.pending.lock().unwrap().is_empty());

        // denial
        let (result, id) = bridge.submit(
            Tool::RunCommand {
                command: "echo denied".into(),
            },
            "web",
            Some(&dir),
        );
        assert!(result.pending.is_some());
        let (r, _) = bridge
            .resolve(id.unwrap(), false, Some(&dir), None)
            .unwrap();
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("denied"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
