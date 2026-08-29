# Tech Stack

The desktop app is the **control center**: it relays tool calls to a web AI acting as a coding agent on the local machine, runs a full git workflow, and shows every command the web AI runs in a single live terminal.

## Application Shell — Tauri

- **Tauri** with a **Rust core** and **React / TypeScript** frontend.
- Chosen over Electron: smaller binary, native OS-level access without bundling a full Chromium + Node runtime, and a materially smaller attack surface — critical since the app executes commands and reads source on the user's machine.

## System / OS Layer — Rust Only

| Concern | Technology |
|---------|------------|
| File watching | OS-native watchers (fsevents / inotify / ReadDirectoryChangesW) |
| Git operations | `git2` (libgit2) — diffs, status, staging, branch, commit history, **commit from the app** |
| Command execution | `portable-pty` — run the web AI's commands as temporary PTY children with timeout + output cap, **streaming output live into the terminal pane** |
| SQLite access | `rusqlite` |

The git panel (full workflow incl. commit) and the command terminal are powered directly by `git2` and `portable-pty` — no external git or terminal process needed.

## Local State — SQLite

Session archive (Layer 1) and structured project memory (Layer 2) both live in embedded SQLite — zero ops, fully local, no server dependency.

## Compression / Summarization — Python + FastAPI

A local microservice, called over localhost, doing LLM-based state compression (Layer 3) using LangChain. The one layer where an LLM call is the tool, not the OS layer — kept isolated from the Rust core.

## Local Agent Capture — CLI Wrapping (PTY)

The developer runs their local agent (Claude Code, etc.) in their **own** terminal — the app does not host or mirror it. Project state for the handoff is gathered on demand from real signals the app can see itself: git status/diff, the filesystem watcher, and the web AI's own tool activity once it takes over.

## Web AI Bridge — Browser Extension + Local IPC

- A **browser extension** (Chrome/Firefox) talks to the desktop app over a localhost/local channel (native messaging or WebSocket).
- The extension injects the handoff into the web chat (ChatGPT / Claude.ai / Gemini / Grok) and relays **tool calls** (`read_file`, `write_file`, `run_command`) between the web AI and the local Rust core.
- The Rust core executes tool calls locally (with permission checks) — `run_command` runs in a one-shot PTY and its output **streams live into the app's terminal pane** — and returns results via the extension into the web chat.

## Why Not C for the OS Layer

Rust already provides C-level OS control with memory safety. Given this app executes commands and reads source, the security cost of introducing C — buffer overflows, manual memory management, FFI complexity — outweighs any negligible performance gain. One systems language, not two.
