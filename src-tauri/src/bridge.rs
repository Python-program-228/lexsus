/// The web-AI coding-agent bridge.
///
/// In Phase 1 this module will:
///   - receive `read_file` / `write_file` / `run_command` tool calls
///     forwarded by the browser extension over local IPC,
///   - execute them locally (with permission checks),
///   - and return the results back to the web AI via the extension.
///
/// Phase 0 ships the data contracts and stubs; the execution plumbing is Phase 1.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Tool {
    ReadFile { path: String },
    WriteFile { path: String, content: String },
    RunCommand { command: String },
    ListDirectory { path: String },
    GitStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub ok: bool,
    pub stdout: Option<String>,
    pub error: Option<String>,
}

/// Stub: marks the tool-call contracts as implemented. Real execution lands in Phase 1.
pub fn tool_not_implemented(tool: &Tool) -> ToolResult {
    ToolResult {
        ok: false,
        stdout: None,
        error: Some(format!("tool not yet implemented in Phase 0: {tool:?}")),
    }
}
