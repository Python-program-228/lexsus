use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::Duration;

/// A file-system change event, normalized across OS-native backends
/// (inotify / fsevents / ReadDirectoryChangesW via the `notify` crate).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FsEvent {
    pub path: PathBuf,
    pub kind: String, // created | modified | removed | renamed | other
}

/// Start a recursive watcher on `path` and return a channel of normalized events.
pub fn watch(path: &Path) -> notify::Result<Receiver<FsEvent>> {
    let (tx, rx) = std::sync::mpsc::channel::<FsEvent>();

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                for p in event.paths {
                    let kind = match event.kind {
                        notify::EventKind::Create(_) => "created".to_string(),
                        notify::EventKind::Modify(_) => "modified".to_string(),
                        notify::EventKind::Remove(_) => "removed".to_string(),
                        notify::EventKind::Any | notify::EventKind::Other => "other".to_string(),
                        notify::EventKind::Access(_) => continue,
                    };
                    // Ignore the watcher's own transient temp writes.
                    let _ = tx.send(FsEvent { path: p, kind });
                }
            }
        },
        Config::default().with_poll_interval(Duration::from_secs(2)),
    )?;

    watcher.watch(path, RecursiveMode::Recursive)?;

    // The watcher lives on a background thread; keep it referenced.
    std::thread::spawn(move || {
        // Keep the watcher alive for the lifetime of the app.
        let _ = watcher;
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    });

    Ok(rx)
}
