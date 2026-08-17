# AI Continuity Bridge

> "Your AI can change. Your work doesn't."

A local-first desktop app that connects your local coding work to **web AIs** (ChatGPT, Claude.ai, Gemini). When your local coding agent — like Claude Code — hits its usage limit, crashes, or you simply want to switch, the bridge captures the real state of your work and turns a web AI into a **real coding agent** that can **read your files, write files, and run terminal commands** on your local machine.

## Overview

You work in Claude Code locally. The desktop app (the **control center**) watches your project in real time — files, git state, terminal — and shows a live activity trace. When your local session is interrupted, the bridge builds a handoff from real project state and delivers it to a web AI (ChatGPT, Claude.ai, Gemini) via a browser extension. The web AI then acts as a coding agent on your machine: it can read, write, and run commands, with every action shown live and grounded to real operations on disk. You never re-explain the project.

## Architecture

Two bridges:

- **Bridge A — Local Agent Capture:** gathers real project state from git, the filesystem watcher, and the web AI's own tool activity once it takes over (the developer runs their local agent in their own terminal — the app does not host or mirror it).
- **Bridge B — Web AI Coding-Agent Bridge:** via a browser extension + local IPC, gives a web AI `read_file`, `write_file`, and `run_command` tools executed locally by the Rust core — with every `run_command` streaming live into the app's single read-only terminal.

Four layers from raw capture to delivered handoff:

1. **Session Archive** — raw session stdin/stdout, timestamps, exit codes; file/git/terminal events
2. **Structured Project Memory** — facts, not chat: objective, decisions, failed attempts, constraints, changed files
3. **Context Compression** — LLM-summarized snapshot sized for a fresh web AI's context window
4. **Handoff Engine** — formats Layer 3 into a web-AI prompt and establishes the coding-agent bridge

## Tech Stack

| Layer | Technology |
|-------|------------|
| Application shell | Tauri (Rust core + React/TypeScript) |
| OS layer | Rust: git2 (git panel + commit), portable-pty (one-shot command execution with live streaming), native fs watchers, rusqlite |
| Local state | SQLite (embedded, fully local) |
| Compression | Python + FastAPI microservice (LangChain) |
| Web AI integration | Browser extension + local IPC tool relay |

## Repository Layout

```
├── README.md
├── docs/                    # Technical documentation
│   ├── architecture.md
│   ├── tech-stack.md
│   └── ui-design.md
├── requirements/            # Product & technical requirements
│   ├── product-requirements.md
│   ├── mvp-scope.md
│   └── trade-offs.md
├── src/                     # React/TypeScript frontend (Tauri shell)
├── src-tauri/               # Rust core (PTY, file watchers, git2, SQLite)
├── compression-service/     # Python + FastAPI LLM compression microservice
└── AI_Continuity_Bridge_Structured_Plan.pdf
```

## Getting Started

_Documentation to be added once scaffolding is complete._

## MVP Success Criterion

A real coding task interrupted in Claude Code is continued by a **web AI** that genuinely reads, writes, and runs commands on the local project — without the developer re-explaining. Validate with 5–10 real developers before adding more web AIs, compression service, or any team/enterprise features.

## License

Internal working document / project.
