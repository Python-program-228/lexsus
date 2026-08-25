//! Session Archive (Layer 1, current design).
//!
//! The app does not host the local Claude Code session; Claude Code
//! persists its own transcripts under `~/.claude/projects`. This module
//! mirrors those files into the app's SQLite archive (`sessions` +
//! `session_events`) idempotently — keyed by source path + mtime — so a
//! session is parsed once per transcript change, never duplicated.

use crate::transcript::{self, TranscriptContext};
use crate::{db, facts};
use rusqlite::Connection;
use std::io::BufRead;
use std::path::{Path, PathBuf};

/// Outcome of an archive pass over one project.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ArchiveReport {
    /// New sessions added to the archive.
    pub archived: usize,
    /// Known sessions refreshed from a changed transcript.
    pub refreshed: usize,
    /// Sessions skipped because the transcript is unchanged.
    pub skipped: usize,
}

/// Persist one parsed transcript context as (or into) a session row.
/// Returns the session id. Safe to call repeatedly: re-archiving the
/// same file refreshes events and facts instead of duplicating rows.
pub fn persist_context(conn: &Connection, ctx: &TranscriptContext) -> Result<i64, String> {
    let source = ctx
        .source
        .as_deref()
        .ok_or_else(|| "context has no source path".to_string())?;
    let session_id = db::upsert_session(
        conn,
        &db::NewSession {
            agent: "claude",
            source,
            cwd: None,
            objective: ctx.objective.as_deref(),
            source_mtime: ctx.last_updated as i64,
        },
    )
    .map_err(|e| e.to_string())?;
    let events: Vec<db::SessionEventRow> = ctx
        .events
        .iter()
        .map(|e| db::SessionEventRow {
            kind: e.kind.clone(),
            payload: e.payload.clone(),
            ts_ms: e.ts_ms as i64,
        })
        .collect();
    db::replace_session_events(conn, session_id, &events).map_err(|e| e.to_string())?;
    let extracted = facts::extract(ctx);
    db::save_facts(conn, session_id, &extracted.into()).map_err(|e| e.to_string())?;
    Ok(session_id)
}

/// Archive every transcript belonging to `project_root`. Returns the
/// report plus the newest session (id + context), so callers can act on
/// the latest state without re-reading anything.
pub fn archive_project(
    conn: &Connection,
    projects_dir: &Path,
    project_root: &Path,
) -> Result<(ArchiveReport, Option<(i64, TranscriptContext)>), String> {
    let mut report = ArchiveReport::default();
    let mut newest: Option<(i64, TranscriptContext)> = None;
    for path in candidates(projects_dir, project_root) {
        let mtime_ms = file_mtime_ms(&path) as i64;
        let stored: Option<i64> = conn
            .query_row(
                "SELECT source_mtime FROM sessions WHERE source = ?1",
                [path.display().to_string()],
                |r| r.get(0),
            )
            .ok();
        if stored.is_some_and(|m| m >= mtime_ms) {
            report.skipped += 1;
            continue;
        }
        let ctx = transcript::parse_transcript(&path)?;
        let id = persist_context(conn, &ctx)?;
        if stored_mtime_is_newer(&newest, ctx.last_updated) {
            newest = Some((id, ctx));
        }
        report.refreshed += 1;
    }
    Ok((report, newest))
}

fn stored_mtime_is_newer(newest: &Option<(i64, TranscriptContext)>, candidate: u64) -> bool {
    match newest {
        Some((_, ctx)) => candidate > ctx.last_updated,
        None => true,
    }
}

/// Transcript files for `project_root`: the munged directory first, then
/// a cwd-matching scan of sibling directories (older layouts).
fn candidates(projects_dir: &Path, project_root: &Path) -> Vec<PathBuf> {
    let fast = projects_dir.join(transcript::munge_path(project_root));
    if fast.is_dir() {
        return jsonl_files(&fast);
    }
    let canonical = project_root.canonicalize().ok();
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(projects_dir) else {
        return out;
    };
    for dir in dirs.flatten().take(100) {
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(newest) = newest_jsonl(&dir.path()) else {
            continue;
        };
        let matches = jsonl_cwd(&newest)
            .and_then(|cwd| PathBuf::from(cwd).canonicalize().ok())
            .map(|c| Some(c) == canonical)
            .unwrap_or(false);
        if matches {
            out.extend(jsonl_files(&dir.path()));
        }
    }
    out
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<(String, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            (p.extension().map(|x| x == "jsonl").unwrap_or(false)).then(|| {
                let key = p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                (key, p)
            })
        })
        .collect();
    files.sort();
    files.into_iter().map(|(_, p)| p).collect()
}

fn newest_jsonl(dir: &Path) -> Option<PathBuf> {
    jsonl_files(dir)
        .into_iter()
        .max_by_key(|p| file_mtime_ms(p))
}

fn jsonl_cwd(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let v: serde_json::Value = serde_json::from_str(&line).ok()?;
    v.get("cwd").and_then(|c| c.as_str()).map(|s| s.to_string())
}

fn file_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for (_, sql) in db::MIGRATIONS {
            conn.execute_batch(sql).unwrap();
        }
        conn
    }

    fn write_transcript(path: &Path, cwd: &str) {
        let mut f = std::fs::File::create(path).unwrap();
        writeln!(
            f,
            r#"{{"type":"session_start","cwd":"{cwd}","session_id":"s"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"user","message":{{"content":"build the login page"}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Write","input":{{"file_path":"src/login.rs"}}}}]}}}}"#
        )
        .unwrap();
    }

    #[test]
    fn archives_once_skips_unchanged_refreshes_changed() {
        let base = std::env::temp_dir().join(format!("lexsus-archive-{}", std::process::id()));
        let claude_dir = base.join(transcript::munge_path(Path::new("/work/app")));
        std::fs::create_dir_all(&claude_dir).unwrap();
        let t1 = claude_dir.join("a.jsonl");
        write_transcript(&t1, "/work/app");
        let root = Path::new("/work/app").to_path_buf();

        let conn = mem_db();
        let dir = base.clone();

        // First pass archives; second pass skips (same mtime).
        let (r1, newest1) = archive_project(&conn, &dir, &root).expect("first archive pass");
        assert_eq!(r1.refreshed, 1);
        let (id1, ctx1) = newest1.expect("newest context returned");
        assert_eq!(ctx1.files_written, vec!["src/login.rs".to_string()]);
        let (r2, _) = archive_project(&conn, &dir, &root).expect("second archive pass");
        assert_eq!(r2.skipped, 1);
        assert_eq!(r2.refreshed, 0);

        // Change the transcript → refreshed, same session row, no dupes.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_transcript(&t1, "/work/app");
        writeln!(
            std::fs::OpenOptions::new().append(true).open(&t1).unwrap(),
            r#"{{"type":"user","message":{{"content":"now add validation"}}}}"#
        )
        .unwrap();
        let (r3, newest3) = archive_project(&conn, &dir, &root).expect("third archive pass");
        assert_eq!(r3.refreshed, 1);
        let (id3, _) = newest3.unwrap();
        assert_eq!(id1, id3);

        let sessions = db::list_sessions(&conn, 10).unwrap();
        assert_eq!(sessions.len(), 1);
        let facts = db::get_facts(&conn, id3).unwrap();
        assert_eq!(facts.changed_files, vec!["src/login.rs".to_string()]);
        let events = db::session_events_for(&conn, id3, 50).unwrap();
        assert!(events
            .iter()
            .any(|e| e.kind == "user" && e.payload.contains("add validation")));

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn fallback_scan_matches_by_cwd() {
        let base = std::env::temp_dir().join(format!("lexsus-archive-scan-{}", std::process::id()));
        // A real project folder (canonicalization must succeed) whose
        // transcript directory name is NOT the munged form.
        let real_root = base.join("work").join("other");
        std::fs::create_dir_all(&real_root).unwrap();
        let odd = base.join("some-odd-layout");
        std::fs::create_dir_all(&odd).unwrap();
        write_transcript(&odd.join("s.jsonl"), &real_root.display().to_string());

        let conn = mem_db();
        let (report, newest) = archive_project(&conn, &base, &real_root).expect("scan archive");
        assert_eq!(report.refreshed, 1);
        assert!(newest.is_some());
        std::fs::remove_dir_all(&base).ok();
    }
}
