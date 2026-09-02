//! MCP (Model Context Protocol) integration.
//!
//! External MCP servers (e.g. CursorTouch/MacOS-MCP) are spawned as child
//! processes and exposed to web AIs as namespaced bridge tools
//! (`mcp__<server>__<tool>`). See `docs/AGENT_RUNTIME_PROTOCOL.md`.

pub mod client;
pub mod manager;

pub use manager::{load_config, McpConfig, McpManager, McpToolInfo, ServerConfig};

/// The app-wide MCP manager. Global because `bridge::execute` reaches it
/// through the dispatcher hook, which cannot carry Tauri state; the Tauri
/// commands use the same instance, so GUI and bridge always agree on
/// which servers are connected.
static MANAGER: std::sync::OnceLock<McpManager> = std::sync::OnceLock::new();

pub fn manager() -> &'static McpManager {
    MANAGER.get_or_init(McpManager::new)
}
