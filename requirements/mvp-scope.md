# MVP Scope — What Ships First

## In Scope

1. **Tauri desktop shell** — single monitored project folder.
2. **Rust-based file watcher + git state extraction** — OS-native watchers + `git2`.
3. **PTY observation of Claude Code** — capture activity and feed the live trace.
4. **SQLite-backed structured memory** — no compression service yet; raw structured state is small enough to hand off directly at MVP scale.
5. **Live activity trace UI** with headroom-collapsing behavior.
6. **Interactive terminal pane** — see and type into live command output.
7. **Git panel (full workflow)** — status, diff, stage/unstage, branch, history, and **commit from the app**.
8. **Browser extension** paired with the desktop app.
9. **Manual interruption → handoff card → "Continue with ChatGPT"** with the web AI able to **read files, write files, and run commands** locally.

## Out of Scope (for MVP)

- Compression / summarization service (Layer 3).
- Multiple web AIs (start with one, e.g. ChatGPT).
- Team / enterprise features.
- Automatic failover.
- Browser automation / DOM scraping (web AI integration via extension only).

## Success Criterion

> A real coding task interrupted in Claude Code is continued by a **web AI** that genuinely reads, writes, and runs commands on the local project — without the developer re-explaining.

Validate with 5–10 real developers before adding more web AIs, compression service, or any team/enterprise features.

**Primary metric:** **Successful continuation rate** — of real interrupted tasks, how many a web AI can continue with real tool access, without re-explanation.
