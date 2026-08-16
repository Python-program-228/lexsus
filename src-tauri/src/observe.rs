//! Observe external coding-agent sessions (opencode first, Claude Code later)
//! and mirror their live activity into the app's terminal as a read-only feed.
//!
//! Backends are deliberately read-only: we never attach, resume, or send
//! anything to the external session. The opencode backend reads its SQLite
//! store (`opencode.db`) in read-only mode; the tail streams newly written
//! `part` rows as they appear.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;

/// A detected external agent session (serialized to the frontend).
#[derive(Debug, Clone, Serialize)]
pub struct ExternalSession {
    pub backend: String,
    pub session_id: String,
    pub title: String,
    /// Working directory the agent is operating in.
    pub cwd: String,
    /// Last activity time in unix milliseconds.
    pub last_ts: u64,
    /// Project worktree the session belongs to.
    pub project_dir: String,
}

/// One rendered feed line, plus the text (if any) that should be fed through
/// the shared `Parser` so external editing/running steps land in the trace.
#[derive(Debug, Clone, Serialize)]
pub struct ObserveOut {
    /// text | thinking | tool | error | step
    pub kind: String,
    /// Rendered line written straight to the terminal.
    pub text: String,
    /// Text to feed the parser ("" = none). File paths are pre-relativized
    /// against the session cwd so watcher confirmation keeps working.
    pub parse: String,
}

/// Handle for an in-progress observe session.
pub struct ObserveHandle {
    pub stop: Arc<AtomicBool>,
    pub session: ExternalSession,
    pub started: Instant,
}

/// Status payload for the `observe://status` event.
#[derive(Debug, Clone, Serialize)]
pub struct ObserveStatusWrapper {
    pub observing: bool,
    pub session: Option<ExternalSession>,
}

impl ObserveStatusWrapper {
    pub fn observing(session: &ExternalSession) -> Self {
        Self {
            observing: true,
            session: Some(session.clone()),
        }
    }

    pub fn idle() -> Self {
        Self {
            observing: false,
            session: None,
        }
    }
}

pub trait ObserveBackend: Send + Sync {
    fn name(&self) -> &'static str;
    /// Look for an active session for `root`. Returns None if none is live.
    fn detect(&self, root: &Path) -> Option<ExternalSession>;
    /// Start tailing `session`, pushing lines into `tx` until `stop` is set.
    fn tail(&self, session: &ExternalSession, tx: Sender<ObserveOut>, stop: Arc<AtomicBool>);
}

pub fn backends() -> Vec<Box<dyn ObserveBackend>> {
    vec![Box::new(OpenCodeBackend)]
}

// ----------------------------------------------------------------------------
// opencode backend (reads opencode.db, read-only)
// ----------------------------------------------------------------------------

pub struct OpenCodeBackend;

impl ObserveBackend for OpenCodeBackend {
    fn name(&self) -> &'static str {
        "opencode"
    }

    fn detect(&self, root: &Path) -> Option<ExternalSession> {
        let db = opencode_db_path()?;
        detect_in(&db, root)
    }

    fn tail(&self, session: &ExternalSession, tx: Sender<ObserveOut>, stop: Arc<AtomicBool>) {
        let Some(db) = opencode_db_path() else {
            return;
        };
        tail_in(&db, session, tx, stop);
    }
}

/// Best-effort location of the live opencode SQLite store.
fn opencode_db_path() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        if let Some(ap) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(ap).join("opencode/opencode.db"));
        }
        if let Some(up) = std::env::var_os("USERPROFILE") {
            candidates.push(PathBuf::from(&up).join(".local/share/opencode/opencode.db"));
        }
    } else if let Some(base) = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    {
        candidates.push(base.join("opencode/opencode.db"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn open_readonly(db: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn path_near(a: &Path, b: &Path) -> bool {
    let a = canon(a);
    let b = canon(b);
    a == b || a.starts_with(&b) || b.starts_with(&a)
}

/// Is the opencode CLI process running with `root` as its working directory?
/// Linux-only (reads `/proc`); other platforms report false and fall back to
/// the activity window.
fn opencode_running_in(root: &Path) -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let Ok(proc) = std::fs::read_dir("/proc") else {
        return false;
    };
    for entry in proc.flatten() {
        let name = entry.file_name();
        let Ok(_pid) = name.to_string_lossy().parse::<u32>() else {
            continue;
        };
        if !entry.path().join("cmdline").is_file() {
            continue;
        }
        let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let first = cmdline.split(|&b| b == 0).next().unwrap_or(&[]);
        if !String::from_utf8_lossy(first).contains("opencode") {
            continue;
        }
        if let Ok(cwd) = std::fs::read_link(entry.path().join("cwd")) {
            if path_near(&cwd, root) {
                return true;
            }
        }
    }
    false
}

/// Is this session still worth mirroring? The opencode process running in the
/// project folder is the strongest signal (idle sessions stream nothing); a
/// generous activity window covers short gaps and non-Linux platforms.
fn session_is_live(
    conn: &Connection,
    session_id: &str,
    updated: i64,
    now: i64,
    process_running: bool,
) -> bool {
    if process_running {
        return (now - updated) < 24 * 60 * 60 * 1000;
    }
    if (now - updated) < 10 * 60 * 1000 {
        return true;
    }
    conn.query_row(
        "SELECT 1 FROM part WHERE session_id = ?1 AND time_updated > ?2 LIMIT 1",
        params![session_id, now - 5 * 60 * 1000],
        |_| Ok(1),
    )
    .is_ok()
}

/// Newest live session (for `root`) inside the opencode store at `db`.
fn detect_in(db: &Path, root: &Path) -> Option<ExternalSession> {
    let conn = open_readonly(db).ok()?;
    let now = now_ms() as i64;
    let process_running = opencode_running_in(root);
    let mut stmt = conn
        .prepare(
            "SELECT id, directory, title, time_updated FROM session \
             ORDER BY time_updated DESC LIMIT 200",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .ok()?;

    let mut best: Option<(ExternalSession, i64)> = None;
    for row in rows.flatten() {
        let (id, directory, title, updated) = row;
        if !path_near(Path::new(&directory), root) {
            continue;
        }
        if !session_is_live(&conn, &id, updated, now, process_running) {
            continue;
        }
        if best.as_ref().map(|(_, u)| updated > *u).unwrap_or(true) {
            best = Some((
                ExternalSession {
                    backend: "opencode".to_string(),
                    session_id: id,
                    title,
                    cwd: directory.clone(),
                    last_ts: updated as u64,
                    project_dir: directory,
                },
                updated,
            ));
        }
    }
    best.map(|(s, _)| s)
}

enum PollResult {
    Done,
    Sent,
    Empty,
    Err,
}

/// Poll for new `part` rows and push rendered lines into `tx`.
fn poll_parts(
    conn: &Connection,
    session_id: &str,
    last_rowid: &mut i64,
    root: &Path,
    tx: &Sender<ObserveOut>,
) -> PollResult {
    let mut stmt = match conn.prepare(
        "SELECT rowid, data FROM part WHERE session_id = ?1 AND rowid > ?2 \
         ORDER BY rowid LIMIT 100",
    ) {
        Ok(s) => s,
        Err(_) => return PollResult::Err,
    };
    let rows = match stmt.query_map(params![session_id, *last_rowid], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    }) {
        Ok(r) => r,
        Err(_) => return PollResult::Err,
    };
    let mut sent = false;
    for row in rows {
        let (rid, data) = match row {
            Ok(v) => v,
            Err(_) => return PollResult::Err,
        };
        *last_rowid = rid;
        let Ok(j) = serde_json::from_str::<serde_json::Value>(&data) else {
            continue;
        };
        if let Some(out) = map_part(root, &j) {
            if tx.send(out).is_err() {
                return PollResult::Done;
            }
            sent = true;
        }
    }
    if sent {
        PollResult::Sent
    } else {
        PollResult::Empty
    }
}

/// Tail new `part` rows for `session` from `db`, streaming into `tx`.
fn tail_in(db: &Path, session: &ExternalSession, tx: Sender<ObserveOut>, stop: Arc<AtomicBool>) {
    let mut conn = match open_readonly(db) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut last_rowid: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(rowid), 0) FROM part WHERE session_id = ?1",
            params![session.session_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let root = PathBuf::from(&session.cwd);

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match poll_parts(&conn, &session.session_id, &mut last_rowid, &root, &tx) {
            PollResult::Done => return,
            PollResult::Sent => thread::sleep(Duration::from_millis(150)),
            PollResult::Empty => thread::sleep(Duration::from_millis(400)),
            PollResult::Err => {
                // Transient store error (locked/compacting) — reconnect and retry.
                thread::sleep(Duration::from_millis(500));
                match open_readonly(db) {
                    Ok(c) => conn = c,
                    Err(_) => return,
                }
            }
        }
    }
}

// ----------------------------------------------------------------------------
// part -> feed line mapping
// ----------------------------------------------------------------------------

fn map_part(root: &Path, j: &serde_json::Value) -> Option<ObserveOut> {
    let type_ = j.get("type").and_then(|v| v.as_str())?;
    match type_ {
        "text" => {
            let text = j.get("text").and_then(|v| v.as_str())?.trim();
            if text.is_empty() {
                return None;
            }
            Some(ObserveOut {
                kind: "text".to_string(),
                text: text.to_string(),
                parse: text.to_string(),
            })
        }
        "reasoning" => {
            let text = j.get("text").and_then(|v| v.as_str())?.trim();
            if text.is_empty() {
                return None;
            }
            Some(ObserveOut {
                kind: "thinking".to_string(),
                text: text.to_string(),
                parse: String::new(),
            })
        }
        "tool" => {
            let name = j.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let state = j.get("state");
            let status = state
                .and_then(|s| s.get("status"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let ok = status == "completed";
            let input = state.and_then(|s| s.get("input"));
            let (feed, parse) = match name {
                "bash" => {
                    let cmd = input
                        .and_then(|i| i.get("command"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    (format!("▶ bash: {}", cmd), format!("Running: {}", cmd))
                }
                "read" => {
                    let fp = file_path(root, input);
                    (format!("○ {}", fp), format!("Reading file: {}", fp))
                }
                "write" | "edit" | "patch" => {
                    let fp = file_path(root, input);
                    (format!("✎ {}", fp), format!("Editing file: {}", fp))
                }
                "grep" | "glob" | "list" | "ls" | "tree" => {
                    let fp = file_path(root, input);
                    (format!("▸ {}", fp), String::new())
                }
                other => (format!("⚙ {}", other), String::new()),
            };
            let detail = state.map(|s| {
                if !ok {
                    s.get("error")
                        .and_then(|v| v.as_str())
                        .map(|e| format!(" ✖ {}", one_line(e)))
                        .unwrap_or_else(|| " ✖ failed".to_string())
                } else {
                    s.get("output")
                        .and_then(output_snippet)
                        .map(|o| format!("  {}", o))
                        .unwrap_or_default()
                }
            });
            let text = format!("{}{}", feed, detail.unwrap_or_default());
            Some(ObserveOut {
                kind: if ok { "tool" } else { "error" }.to_string(),
                text,
                parse,
            })
        }
        "step-start" => Some(ObserveOut {
            kind: "step".to_string(),
            text: "— step —".to_string(),
            parse: String::new(),
        }),
        "step-finish" => {
            let reason = j.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            let tokens = j
                .pointer("/tokens/total")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            Some(ObserveOut {
                kind: "step".to_string(),
                text: format!("— step done · {} tokens · {}", tokens, reason),
                parse: String::new(),
            })
        }
        _ => None,
    }
}

/// Absolute path from a tool input → path relative to `root`.
fn file_path(root: &Path, input: Option<&serde_json::Value>) -> String {
    let raw = input
        .and_then(|i| i.get("filePath"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if raw.is_empty() {
        return String::new();
    }
    let p = Path::new(raw);
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{}…", t)
    }
}

fn output_snippet(v: &serde_json::Value) -> Option<String> {
    let s = match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let s = one_line(&s);
    if s.is_empty() {
        return None;
    }
    Some(truncate(&s, 300))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::Arc;

    fn part(json: &str) -> Option<ObserveOut> {
        map_part(Path::new("/proj"), &serde_json::from_str(json).unwrap())
    }

    fn temp_db() -> (PathBuf, Connection) {
        use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!("observe-test-{}-{}", now_ms(), n));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("opencode.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, \
             directory TEXT NOT NULL, title TEXT NOT NULL, time_updated INTEGER NOT NULL); \
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, \
             session_id TEXT NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL); \
             CREATE INDEX part_session_idx ON part (session_id);",
        )
        .unwrap();
        (path, conn)
    }

    #[test]
    fn maps_text() {
        let o = part(r#"{"type":"text","text":"  hello world  "}"#).unwrap();
        assert_eq!(o.kind, "text");
        assert_eq!(o.text, "hello world");
        assert_eq!(o.parse, "hello world");
    }

    #[test]
    fn maps_blank_text_to_none() {
        assert!(part(r#"{"type":"text","text":"   "}"#).is_none());
    }

    #[test]
    fn maps_reasoning() {
        let o = part(r#"{"type":"reasoning","text":"think think"}"#).unwrap();
        assert_eq!(o.kind, "thinking");
        assert_eq!(o.parse, "");
    }

    #[test]
    fn maps_bash_tool() {
        let o = part(
            r#"{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"npm test"}}}"#,
        )
        .unwrap();
        assert_eq!(o.kind, "tool");
        assert_eq!(o.text, "▶ bash: npm test");
        assert_eq!(o.parse, "Running: npm test");
    }

    #[test]
    fn maps_editing_tool_relative() {
        let o = part(
            r#"{"type":"tool","tool":"write","state":{"status":"completed","input":{"filePath":"/proj/src/App.tsx"}}}"#,
        )
        .unwrap();
        assert_eq!(o.kind, "tool");
        assert_eq!(o.text, "✎ src/App.tsx");
        assert_eq!(o.parse, "Editing file: src/App.tsx");
    }

    #[test]
    fn maps_failed_tool() {
        let o = part(
            r#"{"type":"tool","tool":"bash","state":{"status":"error","input":{"command":"bad cmd"},"error":"boom"}}"#,
        )
        .unwrap();
        assert_eq!(o.kind, "error");
        assert!(o.text.contains("✖ boom"));
        assert_eq!(o.parse, "Running: bad cmd");
    }

    #[test]
    fn maps_step_finish() {
        let o =
            part(r#"{"type":"step-finish","reason":"completed","tokens":{"total":42}}"#).unwrap();
        assert_eq!(o.kind, "step");
        assert!(o.text.contains("42"));
    }

    #[test]
    fn ignores_unknown_types() {
        assert!(part(r#"{"type":"nonsense"}"#).is_none());
    }

    #[test]
    fn output_snippet_truncates() {
        let v = serde_json::json!("ok ".repeat(1000));
        let s = output_snippet(&v).unwrap();
        assert!(s.ends_with('…'));
        assert!(s.chars().count() <= 301);
    }

    #[test]
    fn detect_finds_recent_session_in_root() {
        let (db, conn) = temp_db();
        let root = std::fs::canonicalize(&db)
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let now = now_ms() as i64;
        conn.execute(
            "INSERT INTO session (id, project_id, directory, title, time_updated) \
             VALUES ('ses1', 'p1', ?1, 'Live session', ?2)",
            params![root.display().to_string(), now - 5_000],
        )
        .unwrap();
        let s = detect_in(&db, &root).expect("should detect live session");
        assert_eq!(s.session_id, "ses1");
        assert_eq!(s.title, "Live session");
    }

    #[test]
    fn detect_ignores_stale_sessions() {
        let (db, conn) = temp_db();
        let root = std::fs::canonicalize(&db)
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let now = now_ms() as i64;
        conn.execute(
            "INSERT INTO session (id, project_id, directory, title, time_updated) \
             VALUES ('stale', 'p1', ?1, 'Old session', ?2)",
            params![root.display().to_string(), now - 60 * 60 * 1000],
        )
        .unwrap();
        assert!(detect_in(&db, &root).is_none());
    }

    #[test]
    fn detect_ignores_sessions_outside_root() {
        let (db, conn) = temp_db();
        let now = now_ms() as i64;
        conn.execute(
            "INSERT INTO session (id, project_id, directory, title, time_updated) \
             VALUES ('elsewhere', 'p1', '/tmp/some/other/project', 'Elsewhere', ?1)",
            params![now],
        )
        .unwrap();
        let root = std::fs::canonicalize(&db)
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        assert!(detect_in(&db, &root).is_none());
    }

    #[test]
    fn live_logic_prefers_running_process() {
        let (_db, conn) = temp_db();
        let now = now_ms() as i64;
        let three_hours = now - 3 * 3600 * 1000;
        assert!(!session_is_live(&conn, "x", three_hours, now, false));
        assert!(session_is_live(&conn, "x", three_hours, now, true));
        assert!(!session_is_live(
            &conn,
            "x",
            now - 25 * 3600 * 1000,
            now,
            true
        ));
        assert!(session_is_live(&conn, "x", now - 60_000, now, false));
    }

    #[test]
    fn stale_session_revived_by_recent_part() {
        let (db, conn) = temp_db();
        let now = now_ms() as i64;
        conn.execute(
            "INSERT INTO session (id, project_id, directory, title, time_updated) \
             VALUES ('old', 'p1', '/tmp/some/project', 'Old', ?1)",
            params![now - 6 * 3600 * 1000],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_updated, data) \
             VALUES ('p1', 'm1', 'old', ?1, ?2)",
            params![now - 30_000, r#"{"type":"text","text":"hi"}"#],
        )
        .unwrap();
        assert!(session_is_live(
            &conn,
            "old",
            now - 6 * 3600 * 1000,
            now,
            false
        ));
    }

    #[test]
    fn tail_streams_new_parts_only() {
        let (db, conn) = temp_db();
        let root = std::fs::canonicalize(&db)
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let now = now_ms() as i64;
        conn.execute(
            "INSERT INTO session (id, project_id, directory, title, time_updated) \
             VALUES ('ses2', 'p1', ?1, 'T', ?2)",
            params![root.display().to_string(), now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_updated, data) \
             VALUES ('prt1', 'msg1', 'ses2', ?1, ?2)",
            params![now, r#"{"type":"text","text":"hello"}"#],
        )
        .unwrap();

        let session = ExternalSession {
            backend: "opencode".into(),
            session_id: "ses2".into(),
            title: "T".into(),
            cwd: root.display().to_string(),
            last_ts: now as u64,
            project_dir: root.display().to_string(),
        };

        // Seeded after the first part exists — so only NEW parts should stream.
        let (tx, rx) = mpsc::channel::<ObserveOut>();
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = Arc::clone(&stop);
        let db2 = db.clone();
        let s2 = session.clone();
        let handle = thread::spawn(move || tail_in(&db2, &s2, tx, stop2));

        std::thread::sleep(Duration::from_millis(600));
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_updated, data) \
             VALUES ('prt2', 'msg1', 'ses2', ?1, ?2)",
            params![now + 10, r#"{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"/tmp/some/file.rs"}}}"#],
        )
        .unwrap();

        let out = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("new part should stream");
        assert_eq!(out.kind, "tool");
        assert_eq!(out.text, "○ /tmp/some/file.rs");
        assert_eq!(out.parse, "Reading file: /tmp/some/file.rs");

        stop.store(true, Ordering::Relaxed);
        handle.join().unwrap();
    }
}
