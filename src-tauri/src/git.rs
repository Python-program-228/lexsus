use std::path::Path;

/// A single changed file with its diff (used by the git panel).
#[derive(Debug, Clone, serde::Serialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // untracked | modified | staged | deleted | renamed
    pub additions: usize,
    pub deletions: usize,
}

/// Open a git repository rooted at `path`.
pub fn open_repo(path: &Path) -> Result<git2::Repository, git2::Error> {
    git2::Repository::open(path)
}

/// Return the current branch name, if any.
pub fn current_branch(repo: &git2::Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
}

/// Collect per-file status of the working tree (status, diff line counts).
pub fn status(repo: &git2::Repository) -> Result<Vec<GitFileStatus>, git2::Error> {
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let statuses = repo.statuses(Some(&mut options))?;
    let mut out = Vec::new();

    for entry in statuses.iter() {
        let path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };

        let status = entry.status();
        let kind = if status.contains(git2::Status::WT_NEW) {
            "untracked".to_string()
        } else if status.contains(git2::Status::INDEX_NEW) {
            "staged".to_string()
        } else if status.contains(git2::Status::WT_DELETED)
            || status.contains(git2::Status::INDEX_DELETED)
        {
            "deleted".to_string()
        } else if status.contains(git2::Status::INDEX_RENAMED) {
            "renamed".to_string()
        } else {
            "modified".to_string()
        };

        let (additions, deletions) = diff_counts(repo, &path);
        out.push(GitFileStatus {
            path,
            status: kind,
            additions,
            deletions,
        });
    }

    Ok(out)
}

fn diff_counts(repo: &git2::Repository, path: &str) -> (usize, usize) {
    let mut adds = 0usize;
    let mut dels = 0usize;

    if let Ok(head) = repo.head() {
        let head_commit = match head.peel_to_commit() {
            Ok(c) => c,
            Err(_) => return (0, 0),
        };
        let head_tree = match head_commit.tree() {
            Ok(t) => t,
            Err(_) => return (0, 0),
        };
        let mut opts = git2::DiffOptions::new();
        opts.pathspec(path);
        let diff = repo.diff_tree_to_workdir_with_index(Some(&head_tree), Some(&mut opts));
        if let Ok(diff) = diff {
            for delta in diff.deltas() {
                let f = delta.flags();
                if f.contains(git2::DiffFlags::BINARY) {
                    continue;
                }
            }
            if let Ok(stats) = diff.stats() {
                adds = stats.insertions();
                dels = stats.deletions();
            }
        }
    }

    (adds, dels)
}

/// Create a commit from the current staged state with the given message.
pub fn commit(repo: &git2::Repository, message: &str) -> Result<git2::Oid, git2::Error> {
    let mut index = repo.index()?;
    index.write_tree()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;

    let sig = repo.signature()?;
    let parent = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());

    let oid = match parent {
        Some(pid) => {
            let parent_commit = repo.find_commit(pid)?;
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent_commit])?
        }
        None => repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[])?,
    };

    Ok(oid)
}
