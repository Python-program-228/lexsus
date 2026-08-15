# AI Continuity Bridge

> "Your AI can change. Your work doesn't."

A local-first desktop app that lets a developer's in-progress AI coding session survive interruption — usage limits, crashes, provider outages, or a deliberate switch — by capturing real project state and handing the task to another agent.

## Overview

AI coding agents (Claude Code, Codex CLI, Gemini CLI) run inside a PTY controlled by a Rust core. Every observed action becomes a node in a live activity tree, cross-referenced against OS-native file watchers so the app only reports changes that actually happened. When a session is interrupted, the captured state is compressed and delivered as a handoff prompt to a fresh agent — with no need to re-explain the project.

## Architecture

Four layers, from raw capture to delivered handoff:

1. **Session Archive** — raw PTY session stdin/stdout, timestamps, exit codes
2. **Structured Project Memory** — facts, not chat: objectives, decisions, failed attempts, constraints, changed files
3. **Context Compression** — LLM-summarized snapshot sized for a fresh agent's context window
4. **Handoff Engine** — formats Layer 3 into a provider-specific prompt and re-launches the next agent

## Tech Stack

| Layer | Technology |
|-------|------------|
| Application shell | Tauri (Rust core + React/TypeScript) |
| OS layer | Rust: git2, portable-pty, native fs watchers |
| Local state | SQLite (embedded, fully local) |
| Compression | Python + FastAPI microservice (LangChain) |
| Agent comms | CLI wrapping via PTY |

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

A real interrupted coding task, picked up by a second agent, with the developer not having to re-explain the project. Validate with 5–10 real developers before adding a third agent, compression service, or any team/enterprise features.

## License

Internal working document / project.
