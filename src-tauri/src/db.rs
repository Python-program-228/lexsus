use rusqlite::Connection;
use std::path::Path;

/// Schema migrations, versioned. Each entry applies in order and is
/// recorded in the `schema_migrations` table so migrations are idempotent.
pub const MIGRATIONS: &[(&str, &str)] = &[
    (
        "0001_session_archive",
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            agent       TEXT NOT NULL,
            started_at  TEXT NOT NULL DEFAULT (datetime('now')),
            ended_at    TEXT,
            exit_code   INTEGER,
            objective   TEXT
        );

        CREATE TABLE IF NOT EXISTS session_events (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER NOT NULL REFERENCES sessions(id),
            kind        TEXT NOT NULL,      -- stdin | stdout | command | tool
            payload     TEXT NOT NULL,      -- the captured content
            ts          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_session_events_session
            ON session_events(session_id);
        "#,
    ),
    (
        "0002_structured_project_memory",
        r#"
        CREATE TABLE IF NOT EXISTS objectives (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id),
            text        TEXT NOT NULL,
            active      INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS decisions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id),
            summary     TEXT NOT NULL,
            reason      TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS attempts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id),
            description TEXT NOT NULL,
            succeeded   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS constraints (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id),
            text        TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS changed_files (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id),
            path        TEXT NOT NULL,
            change_kind TEXT NOT NULL,      -- read | write | delete
            mtime       TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_changed_files_path
            ON changed_files(path);

        CREATE TABLE IF NOT EXISTS progress (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id),
            percent     INTEGER NOT NULL DEFAULT 0,
            note        TEXT,
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    ),
    (
        "0003_trace_and_audit",
        r#"
        CREATE TABLE IF NOT EXISTS settings (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS trace_steps (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER REFERENCES sessions(id),
            kind        TEXT NOT NULL,      -- reading | editing | running | test | error
            file        TEXT,
            command     TEXT,
            detail      TEXT,
            confirmed   INTEGER NOT NULL DEFAULT 0,
            ts          TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_trace_steps_session
            ON trace_steps(session_id);

        CREATE TABLE IF NOT EXISTS audit_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            agent       TEXT NOT NULL,      -- claude | web | desktop
            tool        TEXT NOT NULL,
            args        TEXT,
            allowed     INTEGER NOT NULL,   -- 1 allowed / 0 denied
            approved_by TEXT NOT NULL DEFAULT 'auto',
            ok          INTEGER NOT NULL,
            ts          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    ),
];

/// Open (or create) the database and apply any pending migrations.
pub fn open_and_migrate(path: &Path) -> rusqlite::Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version     TEXT PRIMARY KEY,
            applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    for (version, sql) in MIGRATIONS {
        let applied: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
                [version],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !applied {
            let tx = conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version) VALUES (?1)",
                [version],
            )?;
            tx.commit()?;
        }
    }

    Ok(conn)
}

/// Report which migrations are currently applied (for diagnostics/CI).
pub fn applied_versions(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// Persisted key/value settings (project root, pairing code, ...).
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )?;
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

/// Open a session row; returns its id.
pub fn begin_session(conn: &Connection, agent: &str) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO sessions (agent, objective) VALUES (?1, NULL)",
        [agent],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn end_session(
    conn: &Connection,
    session_id: i64,
    exit_code: Option<i32>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE sessions SET ended_at = datetime('now'), exit_code = ?1 WHERE id = ?2",
        (exit_code, session_id),
    )?;
    Ok(())
}

/// Persist a parsed trace step.
pub fn record_trace_step(
    conn: &Connection,
    session_id: Option<i64>,
    kind: &str,
    file: Option<&str>,
    command: Option<&str>,
    detail: Option<&str>,
    confirmed: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO trace_steps (session_id, kind, file, command, detail, confirmed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (session_id, kind, file, command, detail, confirmed as i64),
    )?;
    Ok(())
}

/// Mark recent editing steps for `path` as confirmed (watcher grounding).
pub fn confirm_trace_steps(conn: &Connection, path: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE trace_steps SET confirmed = 1
         WHERE kind = 'editing' AND file = ?1 AND confirmed = 0
           AND ts >= datetime('now', '-30 seconds')",
        [path],
    )
}

/// One audit-log entry (serde: mirrors frontend type).
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuditEntry {
    pub agent: String,
    pub tool: String,
    pub args: String,
    pub allowed: bool,
    pub approved_by: String,
    pub ok: bool,
    pub ts: String,
}

pub fn record_audit(
    conn: &Connection,
    agent: &str,
    tool: &str,
    args: &str,
    allowed: bool,
    approved_by: &str,
    ok: bool,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO audit_log (agent, tool, args, allowed, approved_by, ok)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (agent, tool, args, allowed as i64, approved_by, ok as i64),
    )?;
    Ok(())
}

pub fn last_audit(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<AuditEntry>> {
    let mut stmt = conn.prepare(
        "SELECT agent, tool, args, allowed, approved_by, ok, ts
         FROM audit_log ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit as i64], |row| {
        Ok(AuditEntry {
            agent: row.get(0)?,
            tool: row.get(1)?,
            args: row.get(2)?,
            allowed: row.get::<_, i64>(3)? != 0,
            approved_by: row.get(4)?,
            ok: row.get::<_, i64>(5)? != 0,
            ts: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// Statistics for the handoff card (M2), derived from persisted trace.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TraceStats {
    pub files_changed: usize,
    pub errors: usize,
    pub steps: usize,
    pub last_step: Option<String>,
}

pub fn trace_stats(conn: &Connection) -> rusqlite::Result<TraceStats> {
    let files_changed: usize = conn.query_row(
        "SELECT COUNT(DISTINCT file) FROM trace_steps WHERE kind = 'editing' AND file IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    let errors: usize = conn.query_row(
        "SELECT COUNT(*) FROM trace_steps WHERE kind = 'error'",
        [],
        |r| r.get(0),
    )?;
    let steps: usize = conn.query_row("SELECT COUNT(*) FROM trace_steps", [], |r| r.get(0))?;
    let last_step: Option<String> = conn
        .query_row(
            "SELECT COALESCE(command, file, detail) FROM trace_steps ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(TraceStats {
        files_changed,
        errors,
        steps,
        last_step,
    })
}
