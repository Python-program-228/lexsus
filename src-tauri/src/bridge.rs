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
    ReadFile {
        path: String,
    },
    WriteFile {
        path: String,
        content: String,
    },
    RunCommand {
        command: String,
    },
    ListDirectory {
        path: String,
    },
    GitStatus,
    /// Meta: the full argument schema for one tool. Needs no project root.
    DescribeTool {
        name: String,
    },
    /// Meta: every available tool, grouped. Needs no project root.
    ListTools,
}

/// When a tool call requires an explicit user decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Approval {
    /// Executes immediately.
    Auto,
    /// Executes immediately unless a target path is sensitive.
    SensitivePathOnly,
    /// Always asks.
    Always,
    /// Always asks, and may destroy work — the approval UI must show
    /// exactly what is affected.
    Destructive,
}

/// Static, per-tool metadata. This is the single source of truth: the
/// approval policy, trace kind, timeout, auto-insert behaviour and the
/// AI-facing manifest are all derived from here rather than repeated in
/// separate `match` arms across `bridge.rs`, `ws.rs`, `lib.rs` and the
/// browser extension.
#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub name: &'static str,
    /// Alternate names accepted on the wire. A web AI emits whatever it
    /// remembers — `Grep`, `search_files`, `str_replace`, `bash` — so
    /// resolving aliases directly raises the tool-call hit rate.
    pub aliases: &'static [&'static str],
    /// Argument list for the manifest, e.g. `"path, offset?, limit?"`.
    pub args: &'static str,
    /// One terse line, shown in the manifest.
    pub summary: &'static str,
    pub approval: Approval,
    /// Activity-trace kind, or `None` for calls not worth tracing.
    pub trace_kind: Option<&'static str>,
    pub timeout_ms: u32,
    /// Read-only result the extension can paste straight into the chat.
    pub auto_insert: bool,
    /// Manifest grouping; must appear in [`GROUPS`].
    pub group: &'static str,
}

/// Manifest group order.
pub const GROUPS: &[&str] = &[
    "Reading", "Editing", "Commands", "Search", "Git", "Planning", "Meta",
];

/// Every tool the bridge can execute.
pub const SPECS: &[ToolSpec] = &[
    ToolSpec {
        name: "read_file",
        aliases: &["read", "view_file", "cat", "open_file"],
        args: "path",
        summary: "Read a file's contents",
        approval: Approval::SensitivePathOnly,
        trace_kind: Some("reading"),
        timeout_ms: 10_000,
        auto_insert: true,
        group: "Reading",
    },
    ToolSpec {
        name: "list_directory",
        aliases: &["ls", "list_dir", "list", "dir"],
        args: "path",
        summary: "List the entries of a directory",
        approval: Approval::Auto,
        trace_kind: Some("reading"),
        timeout_ms: 10_000,
        auto_insert: true,
        group: "Reading",
    },
    ToolSpec {
        name: "write_file",
        aliases: &["write", "create_file", "put_file"],
        args: "path, content",
        summary: "Overwrite a file with new content",
        approval: Approval::Always,
        trace_kind: Some("editing"),
        timeout_ms: 15_000,
        auto_insert: false,
        group: "Editing",
    },
    ToolSpec {
        name: "run_command",
        aliases: &["bash", "shell", "execute", "terminal", "sh"],
        args: "command",
        summary: "Run a shell command in the project root",
        approval: Approval::Always,
        trace_kind: Some("running"),
        timeout_ms: 120_000,
        auto_insert: false,
        group: "Commands",
    },
    ToolSpec {
        name: "git_status",
        aliases: &["status", "git_st"],
        args: "",
        summary: "Show changed files in the git working tree",
        approval: Approval::Auto,
        trace_kind: None,
        timeout_ms: 10_000,
        auto_insert: true,
        group: "Git",
    },
    ToolSpec {
        name: "describe_tool",
        aliases: &["tool_help", "help", "tool_info"],
        args: "name",
        summary: "Show the full argument schema for one tool",
        approval: Approval::Auto,
        trace_kind: None,
        timeout_ms: 5_000,
        auto_insert: true,
        group: "Meta",
    },
    ToolSpec {
        name: "list_tools",
        aliases: &["tools", "available_tools"],
        args: "",
        summary: "List every available tool, grouped",
        approval: Approval::Auto,
        trace_kind: None,
        timeout_ms: 5_000,
        auto_insert: true,
        group: "Meta",
    },
];

/// Canonical name of a tool variant.
pub fn tool_name(tool: &Tool) -> &'static str {
    match tool {
        Tool::ReadFile { .. } => "read_file",
        Tool::WriteFile { .. } => "write_file",
        Tool::RunCommand { .. } => "run_command",
        Tool::ListDirectory { .. } => "list_directory",
        Tool::GitStatus => "git_status",
        Tool::DescribeTool { .. } => "describe_tool",
        Tool::ListTools => "list_tools",
    }
}

/// The spec for a tool call. Every [`Tool`] variant has a [`SPECS`] row —
/// `every_variant_has_a_spec` enforces it.
pub fn spec(tool: &Tool) -> &'static ToolSpec {
    let name = tool_name(tool);
    SPECS
        .iter()
        .find(|s| s.name == name)
        .expect("every Tool variant needs a SPECS row")
}

/// Normalize a wire tool name: strip any namespace prefix
/// (`default_api.read_file`), lowercase, and treat `-`/space as `_`.
fn normalize_tool_name(name: &str) -> String {
    name.rsplit('.')
        .next()
        .unwrap_or(name)
        .trim()
        .chars()
        .map(|c| match c {
            '-' | ' ' => '_',
            c => c.to_ascii_lowercase(),
        })
        .collect()
}

/// Look up a spec by canonical name or alias.
pub fn spec_by_name(name: &str) -> Option<&'static ToolSpec> {
    let n = normalize_tool_name(name);
    SPECS
        .iter()
        .find(|s| s.name == n || s.aliases.contains(&n.as_str()))
}

/// The compact, grouped tool manifest handed to a web AI. Deliberately
/// terse: full per-tool docs for every tool would crowd out the actual
/// project context, so the AI calls `describe_tool` for detail on demand.
///
/// Rendered as an aligned table, **never** as `name(args)`. This is the body
/// of `list_tools`, which auto-inserts into the chat, so the AI echoes it
/// back — and the extension's line parser matched the call form, executing
/// the whole tool surface at once. `run_command`'s pattern treats the quote
/// as optional, so even `run_command(shell command)` fired. Keep it inert.
pub fn tool_manifest() -> String {
    let mut out = String::new();
    for group in GROUPS {
        let rows: Vec<_> = SPECS.iter().filter(|s| &s.group == group).collect();
        if rows.is_empty() {
            continue;
        }
        out.push_str(group);
        out.push('\n');
        for s in rows {
            let args = if s.args.is_empty() { "—" } else { s.args };
            out.push_str(&format!("  {:<16} {:<17} {}\n", s.name, args, s.summary));
        }
    }
    out
}

/// Full detail for one tool, for `describe_tool`. Also auto-inserted into the
/// chat, so it avoids call syntax for the same reason as `tool_manifest`.
fn describe_spec(s: &ToolSpec) -> String {
    let approval = match s.approval {
        Approval::Auto => "runs immediately",
        Approval::SensitivePathOnly => "runs immediately unless the path is sensitive",
        Approval::Always => "requires the user's approval",
        Approval::Destructive => "requires the user's approval (may destroy work)",
    };
    let mut out = format!("{}\n  {}\n", s.name, s.summary);
    if s.args.is_empty() {
        out.push_str("  Arguments: none\n");
    } else {
        out.push_str(&format!("  Arguments: {}\n", s.args));
    }
    out.push_str(&format!("  Approval: {approval}\n"));
    out.push_str(&format!("  Timeout: {}ms\n", s.timeout_ms));
    if !s.aliases.is_empty() {
        out.push_str(&format!("  Also accepted as: {}\n", s.aliases.join(", ")));
    }
    out
}

/// Filesystem paths a call touches, for the sensitive-path policy. Tools
/// that take two paths must return both, or a secret can be laundered by
/// copying it to an innocuous name.
pub fn tool_paths(tool: &Tool) -> Vec<&str> {
    match tool {
        Tool::ReadFile { path } | Tool::WriteFile { path, .. } | Tool::ListDirectory { path } => {
            vec![path.as_str()]
        }
        Tool::RunCommand { .. } | Tool::GitStatus | Tool::DescribeTool { .. } | Tool::ListTools => {
            vec![]
        }
    }
}

/// The per-call detail shown beside the tool name in the approval UI,
/// audit log and activity trace.
pub fn detail(tool: &Tool) -> Option<String> {
    match tool {
        Tool::ReadFile { path } | Tool::ListDirectory { path } => Some(path.clone()),
        Tool::WriteFile { path, content } => Some(format!("{path} ({} bytes)", content.len())),
        Tool::RunCommand { command } => Some(command.clone()),
        Tool::DescribeTool { name } => Some(name.clone()),
        Tool::GitStatus | Tool::ListTools => None,
    }
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

/// Structured error code for tool call failures.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    FileNotFound,
    FileIsBinary,
    FileTooLarge,
    PathEscapesRoot,
    PermissionDenied,
    SensitivePath,
    InvalidArguments,
    MalformedJson,
    ExecutionFailed,
    CommandTimeout,
    ConnectionLost,
    NotPaired,
    UnknownTool,
    InternalError,
    Denied,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErrorCode::FileNotFound => write!(f, "FILE_NOT_FOUND"),
            ErrorCode::FileIsBinary => write!(f, "FILE_IS_BINARY"),
            ErrorCode::FileTooLarge => write!(f, "FILE_TOO_LARGE"),
            ErrorCode::PathEscapesRoot => write!(f, "PATH_ESCAPES_ROOT"),
            ErrorCode::PermissionDenied => write!(f, "PERMISSION_DENIED"),
            ErrorCode::SensitivePath => write!(f, "SENSITIVE_PATH"),
            ErrorCode::InvalidArguments => write!(f, "INVALID_ARGUMENTS"),
            ErrorCode::MalformedJson => write!(f, "MALFORMED_JSON"),
            ErrorCode::ExecutionFailed => write!(f, "EXECUTION_FAILED"),
            ErrorCode::CommandTimeout => write!(f, "COMMAND_TIMEOUT"),
            ErrorCode::ConnectionLost => write!(f, "CONNECTION_LOST"),
            ErrorCode::NotPaired => write!(f, "NOT_PAIRED"),
            ErrorCode::UnknownTool => write!(f, "UNKNOWN_TOOL"),
            ErrorCode::InternalError => write!(f, "INTERNAL_ERROR"),
            ErrorCode::Denied => write!(f, "DENIED"),
        }
    }
}

/// A structured error response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolError {
    pub code: ErrorCode,
    pub message: String,
}

/// Result of a tool call. `pending` is set when the call awaits an
/// explicit user approval (the caller should wait for resolution).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    pub output: Option<String>,
    pub error: Option<String>,
    pub error_code: Option<ErrorCode>,
    pub pending: Option<String>,
}

impl ToolResult {
    pub fn ok(output: String) -> Self {
        Self {
            ok: true,
            output: Some(output),
            error: None,
            error_code: None,
            pending: None,
        }
    }
    pub fn err<S: Into<String>>(error: S) -> Self {
        Self {
            ok: false,
            output: None,
            error: Some(error.into()),
            error_code: None,
            pending: None,
        }
    }
    pub fn err_code(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            output: None,
            error: Some(message.into()),
            error_code: Some(code),
            pending: None,
        }
    }
    pub fn pending<S: Into<String>>(summary: S) -> Self {
        Self {
            ok: false,
            output: None,
            error: None,
            error_code: None,
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
            ToolResult::err_code(
                ErrorCode::Denied,
                format!("denied by user: {}", req.summary),
            )
        };

        if let Some(tx) = self.channels.lock().unwrap().remove(&id) {
            let _ = tx.send(result.clone());
        }
        Some((result, req))
    }
}

/// Human-readable summary of a tool call (for the approval UI + audit).
pub fn describe(tool: &Tool) -> String {
    let name = tool_name(tool);
    match detail(tool) {
        Some(d) => format!("{name} {d}"),
        None => name.to_string(),
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
/// Derived entirely from the tool's [`ToolSpec`] — adding a tool means
/// adding a `SPECS` row, not editing this function.
pub fn needs_approval(tool: &Tool) -> Option<String> {
    let s = spec(tool);
    match s.approval {
        Approval::Auto => None,
        Approval::SensitivePathOnly => tool_paths(tool)
            .into_iter()
            .any(|p| is_sensitive_path(Path::new(p)))
            .then(|| "read of sensitive path".to_string()),
        Approval::Always => Some(s.name.to_string()),
        Approval::Destructive => Some(format!("{} (destructive)", s.name)),
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
    // Meta-tools answer from the spec table, so they work before a project
    // is opened — an AI that has lost the manifest can always recover it.
    match tool {
        Tool::ListTools => {
            return ToolResult::ok(tool_manifest());
        }
        Tool::DescribeTool { name } => {
            return match spec_by_name(name) {
                Some(s) => ToolResult::ok(describe_spec(s)),
                None => ToolResult::err_code(
                    ErrorCode::UnknownTool,
                    format!("unknown tool: {name}. Call list_tools for the full list."),
                ),
            };
        }
        _ => {}
    }

    let Some(root) = root else {
        return ToolResult::err_code(ErrorCode::InternalError, "project root not set");
    };

    match tool {
        Tool::ReadFile { path } => {
            let p = match resolve_path(root, path) {
                Ok(p) => p,
                Err(e) => {
                    if e.contains("escapes project root") {
                        return ToolResult::err_code(ErrorCode::PathEscapesRoot, e);
                    }
                    return ToolResult::err_code(ErrorCode::FileNotFound, e);
                }
            };
            match std::fs::metadata(&p) {
                Ok(md) if md.is_dir() => {
                    return ToolResult::err_code(
                        ErrorCode::InvalidArguments,
                        format!("is a directory: {path}"),
                    );
                }
                Err(e) => {
                    return ToolResult::err_code(ErrorCode::FileNotFound, format!("{path}: {e}"));
                }
                _ => {}
            }
            match std::fs::read(&p) {
                Ok(bytes) => {
                    if bytes.contains(&0) {
                        return ToolResult::err_code(
                            ErrorCode::FileIsBinary,
                            format!("{}: binary file ({} bytes, not shown)", path, bytes.len()),
                        );
                    }
                    if bytes.len() as u64 > READ_CAP {
                        return ToolResult::err_code(
                            ErrorCode::FileTooLarge,
                            format!("{path}: file too large ({})", bytes.len()),
                        );
                    }
                    ToolResult::ok(String::from_utf8_lossy(&bytes).into_owned())
                }
                Err(e) => ToolResult::err_code(ErrorCode::ExecutionFailed, format!("{path}: {e}")),
            }
        }
        Tool::WriteFile { path, content } => {
            let p = match resolve_path(root, path) {
                Ok(p) => p,
                Err(e) => {
                    if e.contains("escapes project root") {
                        return ToolResult::err_code(ErrorCode::PathEscapesRoot, e);
                    }
                    return ToolResult::err_code(ErrorCode::FileNotFound, e);
                }
            };
            if let Some(parent) = p.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return ToolResult::err_code(
                        ErrorCode::ExecutionFailed,
                        format!("{path}: {e}"),
                    );
                }
            }
            match std::fs::write(&p, content.as_bytes()) {
                Ok(()) => ToolResult::ok(format!("wrote {} bytes to {path}", content.len())),
                Err(e) => ToolResult::err_code(ErrorCode::ExecutionFailed, format!("{path}: {e}")),
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
                    return ToolResult::err_code(
                        ErrorCode::ExecutionFailed,
                        format!("run_command failed: {e}"),
                    );
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
                return ToolResult::err_code(ErrorCode::CommandTimeout, text);
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
                Err(e) => {
                    if e.contains("escapes project root") {
                        return ToolResult::err_code(ErrorCode::PathEscapesRoot, e);
                    }
                    return ToolResult::err_code(ErrorCode::FileNotFound, e);
                }
            };
            let mut names = Vec::new();
            match std::fs::read_dir(&p) {
                Ok(entries) => {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        names.push(name);
                    }
                }
                Err(e) => {
                    return ToolResult::err_code(ErrorCode::ExecutionFailed, format!("{path}: {e}"))
                }
            }
            names.sort();
            let mut out = format!("[{} entries]\n", names.len());
            out.push_str(&names.join("\n"));
            ToolResult::ok(out)
        }
        Tool::GitStatus => {
            let repo = match git::open_repo(root) {
                Ok(r) => r,
                Err(e) => {
                    return ToolResult::err_code(
                        ErrorCode::ExecutionFailed,
                        format!("not a git repo: {e}"),
                    );
                }
            };
            let statuses = match git::status(&repo) {
                Ok(s) => s,
                Err(e) => {
                    return ToolResult::err_code(
                        ErrorCode::ExecutionFailed,
                        format!("git status: {e}"),
                    );
                }
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
        // Handled above, before the project-root check.
        Tool::DescribeTool { .. } | Tool::ListTools => unreachable!(),
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

    /// One row per variant. Kept exhaustive by the `match` below, so adding
    /// a `Tool` variant without a `SPECS` row fails to compile here.
    fn every_variant() -> Vec<Tool> {
        let all = vec![
            Tool::ReadFile { path: "a".into() },
            Tool::WriteFile {
                path: "a".into(),
                content: String::new(),
            },
            Tool::RunCommand {
                command: "true".into(),
            },
            Tool::ListDirectory { path: ".".into() },
            Tool::GitStatus,
            Tool::DescribeTool {
                name: "read_file".into(),
            },
            Tool::ListTools,
        ];
        for t in &all {
            // Exhaustive: the compiler flags a new variant missing above.
            match t {
                Tool::ReadFile { .. }
                | Tool::WriteFile { .. }
                | Tool::RunCommand { .. }
                | Tool::ListDirectory { .. }
                | Tool::GitStatus
                | Tool::DescribeTool { .. }
                | Tool::ListTools => {}
            }
        }
        all
    }

    #[test]
    fn every_variant_has_a_spec() {
        for tool in every_variant() {
            let s = spec(&tool); // panics when the row is missing
            assert!(
                GROUPS.contains(&s.group),
                "{}: group {:?} is not in GROUPS",
                s.name,
                s.group
            );
            assert!(!s.summary.is_empty(), "{}: needs a summary", s.name);
            assert!(s.timeout_ms > 0, "{}: needs a timeout", s.name);
        }
    }

    #[test]
    fn tool_names_and_aliases_are_unique() {
        let mut seen: Vec<&str> = Vec::new();
        for s in SPECS {
            for name in std::iter::once(&s.name).chain(s.aliases.iter()) {
                assert!(
                    !seen.contains(name),
                    "{name:?} is claimed twice — resolution would be order-dependent"
                );
                seen.push(*name);
            }
        }
    }

    #[test]
    fn aliases_resolve() {
        for (input, expected) in [
            ("read_file", "read_file"),
            ("Read", "read_file"),
            ("cat", "read_file"),
            ("bash", "run_command"),
            ("Shell", "run_command"),
            ("ls", "list_directory"),
            ("list-dir", "list_directory"),
            ("default_api.write_file", "write_file"),
            ("  git_status  ", "git_status"),
        ] {
            assert_eq!(
                spec_by_name(input).map(|s| s.name),
                Some(expected),
                "{input:?} should resolve to {expected}"
            );
        }
        assert!(spec_by_name("teleport").is_none());
    }

    #[test]
    fn meta_tools_need_no_project_root() {
        let r = execute(&Tool::ListTools, None, None);
        assert!(r.ok, "{:?}", r.error);
        let manifest = r.output.unwrap();
        for s in SPECS {
            assert!(manifest.contains(s.name), "manifest omits {}", s.name);
        }

        let r = execute(
            &Tool::DescribeTool {
                name: "grep".into(), // not implemented yet
            },
            None,
            None,
        );
        assert!(!r.ok);
        assert!(
            r.error.unwrap().contains("list_tools"),
            "point the AI at a recovery path"
        );

        // An alias is enough to look a tool up.
        let r = execute(&Tool::DescribeTool { name: "cat".into() }, None, None);
        assert!(r.ok, "{:?}", r.error);
        assert!(r.output.unwrap().contains("read_file"));
    }

    #[test]
    fn describe_keeps_the_summary_format() {
        assert_eq!(
            describe(&Tool::ReadFile {
                path: "src/a.ts".into()
            }),
            "read_file src/a.ts"
        );
        assert_eq!(
            describe(&Tool::WriteFile {
                path: "a.ts".into(),
                content: "abc".into()
            }),
            "write_file a.ts (3 bytes)"
        );
        assert_eq!(describe(&Tool::GitStatus), "git_status");
    }

    #[test]
    fn manifest_stays_small() {
        // Progressive disclosure: the manifest competes with real project
        // context in the AI's window, so keep it terse even at 44 tools.
        let manifest = tool_manifest();
        assert!(
            manifest.len() < 4_000,
            "manifest is {} bytes — move detail into describe_tool",
            manifest.len()
        );
    }

    #[test]
    fn manifest_and_describe_are_not_call_syntax() {
        // `list_tools` and `describe_tool` auto-insert into the chat, so the AI
        // echoes their output back and the extension's line parser sees it. In
        // call syntax every row was a live tool call: echoing the manifest ran
        // the whole surface, approval cards and all, and froze the page.
        let mut text = tool_manifest();
        for s in SPECS {
            text.push_str(&describe_spec(s));
        }
        for s in SPECS {
            assert!(
                !text.contains(&format!("{}(", s.name)),
                "{} is rendered in call syntax — it will execute when echoed",
                s.name
            );
        }
        // run_command's pattern makes the quote optional, so unquoted parens
        // anywhere in this text are enough to fire it.
        assert!(!text.contains("(shell command)"));
    }
}
