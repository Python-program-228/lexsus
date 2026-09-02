//! The MCP manager: owns every connected MCP server, routes namespaced
//! tool calls (`mcp__<server>__<tool>`) to the right client, and loads
//! server definitions from `mcp.json`.
//!
//! Hardening over the original draft:
//!
//!   * Clients live behind `Arc`, and the map lock is **never held across
//!     a blocking request** — a slow server no longer freezes every other
//!     server and, more importantly, the whole bridge.
//!   * Dead clients (EOF / broken pipe) are evicted on the next access
//!     instead of poisoning the map forever.
//!   * Servers are started from a config file, not hardcoded — see
//!     [`ServerConfig`] and [`load_config`].
//!   * `tools/list` results are cached per server so the approval gate can
//!     read `annotations.readOnlyHint` without a round-trip per call.

use super::client::McpClient;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// One server entry from `mcp.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Short unique name, used as the `mcp__<name>__…` namespace.
    pub name: String,
    /// Executable, e.g. `"npx"` or `"/usr/local/bin/macos-mcp"`.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Set false to keep the entry but not autostart it.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Per-request timeout in seconds (default: 60).
    pub timeout_secs: Option<u64>,
}

fn default_true() -> bool {
    true
}

/// Contents of `mcp.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(default)]
    pub servers: Vec<ServerConfig>,
}

/// Load `mcp.json`. A missing file is **not** an error (MCP is optional);
/// a malformed one is.
pub fn load_config(path: &Path) -> Result<McpConfig, String> {
    if !path.exists() {
        return Ok(McpConfig::default());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// A tool as advertised by a server, plus the routing/approval metadata
/// the runtime needs.
#[derive(Debug, Clone, Serialize)]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    /// Namespaced wire name: `mcp__<server>__<name>`.
    pub wire_name: String,
    pub description: String,
    /// From `annotations.readOnlyHint`; absent → false (treated as
    /// write-capable, i.e. Always-approve).
    pub read_only: bool,
}

struct Connected {
    client: Arc<McpClient>,
    /// name → read_only, filled from the last successful `tools/list`.
    tools: Mutex<HashMap<String, bool>>,
}

#[derive(Default)]
pub struct McpManager {
    clients: Mutex<HashMap<String, Connected>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn + handshake a server and cache its tool list.
    pub fn connect(&self, cfg: &ServerConfig) -> Result<(), String> {
        let timeout = cfg.timeout_secs.map(Duration::from_secs);
        let env: Vec<(String, String)> = cfg
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let client = McpClient::spawn(&cfg.command, &cfg.args, &env, timeout)?;
        let pid = client.pid();
        client.initialize()?;
        let client = Arc::new(client);

        // Cache tool annotations for the approval gate.
        let mut tools = HashMap::new();
        if let Ok(res) = client.list_tools() {
            if let Some(list) = res.get("tools").and_then(|t| t.as_array()) {
                for t in list {
                    if let Some(name) = t.get("name").and_then(|n| n.as_str()) {
                        let ro = t
                            .get("annotations")
                            .and_then(|a| a.get("readOnlyHint"))
                            .and_then(|r| r.as_bool())
                            .unwrap_or(false);
                        tools.insert(name.to_string(), ro);
                    }
                }
            }
        }

        eprintln!("[mcp] connected '{}' (pid {pid}, {} tools)", cfg.name, tools.len());
        self.clients.lock().unwrap().insert(
            cfg.name.clone(),
            Connected {
                client,
                tools: Mutex::new(tools),
            },
        );
        Ok(())
    }

    /// Start every enabled server from a config, collecting per-server
    /// errors instead of failing the whole batch.
    pub fn autostart(&self, config: &McpConfig) -> Vec<(String, String)> {
        let mut errors = Vec::new();
        for srv in &config.servers {
            if !srv.enabled {
                continue;
            }
            if let Err(e) = self.connect(srv) {
                eprintln!("[mcp] autostart '{}' failed: {e}", srv.name);
                errors.push((srv.name.clone(), e));
            }
        }
        errors
    }

    /// Snapshot a client by server name, evicting it first if dead.
    /// The returned `Arc` lets callers do blocking I/O with no lock held.
    fn client_for(&self, server: &str) -> Result<Arc<McpClient>, String> {
        let mut clients = self.clients.lock().unwrap();
        if let Some(c) = clients.get(server) {
            if c.client.is_dead() {
                eprintln!("[mcp] evicting dead server '{server}'");
                clients.remove(server);
                return Err(format!("MCP server '{server}' died and was disconnected"));
            }
            Ok(c.client.clone())
        } else {
            Err(format!("MCP server '{server}' not connected"))
        }
    }

    pub fn connected_servers(&self) -> Vec<String> {
        self.clients.lock().unwrap().keys().cloned().collect()
    }

    pub fn disconnect(&self, server: &str) -> bool {
        // Dropping the client kills the child (see McpClient::drop).
        self.clients.lock().unwrap().remove(server).is_some()
    }

    /// Every tool of every live server, namespaced.
    pub fn list_tools(&self) -> Vec<McpToolInfo> {
        let snapshot: Vec<(String, Arc<McpClient>)> = self
            .clients
            .lock()
            .unwrap()
            .iter()
            .map(|(n, c)| (n.clone(), c.client.clone()))
            .collect();

        let mut out = Vec::new();
        for (server, client) in snapshot {
            let Ok(res) = client.list_tools() else {
                continue; // a dead server contributes nothing
            };
            let read_only_map: HashMap<String, bool> = self
                .clients
                .lock()
                .unwrap()
                .get(&server)
                .map(|c| c.tools.lock().unwrap().clone())
                .unwrap_or_default();
            if let Some(list) = res.get("tools").and_then(|t| t.as_array()) {
                for t in list {
                    let Some(name) = t.get("name").and_then(|n| n.as_str()) else {
                        continue;
                    };
                    out.push(McpToolInfo {
                        server: server.clone(),
                        name: name.to_string(),
                        wire_name: format!("mcp__{server}__{name}"),
                        description: t
                            .get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("")
                            .to_string(),
                        read_only: read_only_map.get(name).copied().unwrap_or(false),
                    });
                }
            }
        }
        out
    }

    /// Is this tool read-only per the server's `annotations`?
    /// Unknown → false (safer: the call goes through Always approval).
    pub fn tool_is_read_only(&self, server: &str, tool: &str) -> bool {
        self.clients
            .lock()
            .unwrap()
            .get(server)
            .and_then(|c| c.tools.lock().unwrap().get(tool).copied())
            .unwrap_or(false)
    }

    /// Call a tool on a server. No lock is held during the request.
    pub fn call_tool(&self, server: &str, tool: &str, args: Value) -> Result<Value, String> {
        let client = self.client_for(server)?;
        client.call_tool(tool, args)
    }

    /// Parse a namespaced wire name `mcp__<server>__<tool>` back into its
    /// parts. Server and tool names may not contain `__`.
    pub fn parse_wire_name(wire: &str) -> Option<(String, String)> {
        let rest = wire.strip_prefix("mcp__")?;
        let (server, tool) = rest.split_once("__")?;
        if server.is_empty() || tool.is_empty() {
            return None;
        }
        Some((server.to_string(), tool.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_name_roundtrip() {
        let (s, t) = McpManager::parse_wire_name("mcp__macos__click").unwrap();
        assert_eq!(s, "macos");
        assert_eq!(t, "click");
        assert!(McpManager::parse_wire_name("mcp__onlyserver").is_none());
        assert!(McpManager::parse_wire_name("read_file").is_none());
        assert!(McpManager::parse_wire_name("mcp____tool").is_none());
    }

    #[test]
    fn missing_config_is_ok() {
        let cfg = load_config(Path::new("/definitely/not/here.json")).unwrap();
        assert!(cfg.servers.is_empty());
    }

    #[test]
    fn parse_config() {
        let json = r#"{"servers": [{
            "name": "macos",
            "command": "npx",
            "args": ["-y", "@cursortouch/macos-mcp"],
            "env": {"FOO": "bar"},
            "timeout_secs": 30
        }]}"#;
        let cfg: McpConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.servers.len(), 1);
        assert!(cfg.servers[0].enabled);
        assert_eq!(cfg.servers[0].timeout_secs, Some(30));
        assert_eq!(cfg.servers[0].env.get("FOO").unwrap(), "bar");
    }
}
