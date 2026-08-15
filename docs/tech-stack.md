# Tech Stack

## Application Shell — Tauri

- **Tauri** with a **Rust core** and **React / TypeScript** frontend.
- Chosen over Electron: smaller binary, native OS-level access without bundling a full Chromium + Node runtime, and a materially smaller attack surface — important given this app touches source code, git history, and potentially secrets.

## System / OS Layer — Rust Only

- **File watching** — OS-native watchers (fsevents / inotify / ReadDirectoryChangesW)
- **Git operations** — `git2` (Rust bindings to libgit2) for diffs, status, branch/commit state
- **Process / PTY control** — spawns and controls CLI agents as child processes with full stdin/stdout/stderr access via `portable-pty`

## Local State — SQLite

Structured project memory (Layer 2) and session archive (Layer 1) both live in embedded SQLite — zero ops, fully local, no server dependency.

## Compression / Summarization — Python + FastAPI

A local microservice, called over localhost, doing LLM-based state compression using LangChain. The one layer where an LLM call is the tool, not the OS layer — kept isolated from the Rust core.

## Agent Communication — CLI Wrapping (PTY), Not Browser Automation

Claude Code, Codex CLI, and Gemini CLI are spawned as child processes inside a PTY controlled by the Rust core. The app injects the handoff context as the opening input, and passively observes all terminal output for interruption-detection and activity-tracking.

## Why Not C for the OS Layer

Rust already provides C-level OS control with memory safety. Given this app has direct access to source code, credentials, and shell execution, the security cost of introducing C — buffer overflows, manual memory management, FFI complexity — outweighs any negligible performance gain. One systems language, not two.
