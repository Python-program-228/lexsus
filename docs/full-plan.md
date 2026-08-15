# AI Continuity Bridge — Full Project Plan

> **"Your AI can change. Your work doesn't."**

A local-first desktop application that lets a developer's in-progress AI coding session survive interruption — usage limits, crashes, provider outages, context limits, or a deliberate switch — by capturing real project state and handing the task to another agent.

This document consolidates the technical plan, startup validation, and build roadmap into one end-to-end reference.

---

## Table of Contents

1. [Vision & Positioning](#1-vision--positioning)
2. [Problem & Core Insight](#2-problem--core-insight)
3. [Product Overview](#3-product-overview)
4. [Architecture](#4-architecture)
5. [Tech Stack](#5-tech-stack)
6. [Full Feature List](#6-full-feature-list)
7. [Agent Adapters Roadmap](#7-agent-adapters-roadmap)
8. [Security Model](#8-security-model)
9. [Business Model & Market](#9-business-model--market)
10. [Risk Register](#10-risk-register)
11. [MVP Scope & Success Criteria](#11-mvp-scope--success-criteria)
12. [Phased Development Roadmap](#12-phased-development-roadmap)
13. [Milestones & Definition of Done](#13-milestones--definition-of-done)
14. [Validation Metrics](#14-validation-metrics)

---

## 1. Vision & Positioning

**Core principle:** The AI should be replaceable. The user's work should not be.

**Strong positioning (what we build):**
> "A local-first AI continuity layer that lets developers move ongoing work between AI agents without losing project state."

**Weak positioning (what we avoid):**
> "When Claude reaches its limit, switch to ChatGPT." — too narrow, easy to copy, and sounds like a workaround.

The product is the **neutral layer between models**, not "another coding agent." The strongest message is not "our AI is smarter," but *"We don't care which AI you use. Your work continues."*

**Tagline:** Your AI can change. Your work doesn't.

---

## 2. Problem & Core Insight

### The Problem
AI coding agents increasingly perform real multi-step development: reading repositories, modifying files, running commands, debugging, testing, and implementing features. This creates a new dependency — developers give an AI an ongoing job rather than asking isolated questions.

If the agent stops halfway (usage limit, crash, outage, context limit), the developer may have to re-explain the project to another AI. The lost value is not chat history — it is **working context**: what was attempted, what was completed, why decisions were made, which files changed, what failed, and what remains.

> **Problem statement:** AI-assisted work can be interrupted because its context and execution are tied too closely to one provider.

### The Core Insight
Today's pattern: `USER → AI → CONVERSATION HISTORY`

Proposed pattern: `USER → CONTINUITY BRIDGE → AI AGENTS`

The local project and task state act as the persistent layer. Claude, Codex, Gemini, or another model becomes an **interchangeable worker**. The user cares about the task, not which provider currently performs it.

---

## 3. Product Overview

### What It Is
A local-first AI continuity layer that captures real project state and hands ongoing work between AI agents.

### What It Is Not
- Not a "limit bypass" tool
- Not a chatbot
- Not a conversation saver (though it archives sessions)

### Triggers (not just usage limits)
Usage limits are the entry point, not the foundation. Other triggers include:

- Provider outages
- Context limits
- Crashes / hangs
- Poor performance
- Model specialization
- Privacy requirements
- Cost optimization
- Deliberate switching

---

## 4. Architecture

Four layers, from raw capture to delivered handoff:

| Layer | Purpose | What it stores / does |
|-------|---------|-----------------------|
| 1. **Session Archive** | Raw capture | Every PTY session's stdin/stdout, timestamps, exit codes |
| 2. **Structured Project Memory** | Facts, not chat | Objective, decisions, failed attempts, constraints, changed files |
| 3. **Context Compression** | Make state handoff-sized | LLM-summarized snapshot of Layer 2, sized for a fresh agent's context window |
| 4. **Handoff Engine** | Translate + deliver | Formats Layer 3 into a provider-specific prompt and re-launches the next agent |

### Why Local-First Matters
The local project is often more trustworthy than an AI's self-reported state. The bridge can inspect files, Git diffs, terminal output, build status, tests, package configuration, and database schema. This transfers **actual work state** rather than merely copying a conversation.

Local-first also reduces privacy concerns and makes the product more attractive to professional and enterprise developers — sensitive source code need not pass through the company's own servers.

---

## 5. Tech Stack

### Application Shell — Tauri
- **Tauri** with a **Rust core** and **React / TypeScript** frontend.
- Chosen over Electron: smaller binary, native OS-level access without bundling Chromium + Node, and a materially smaller attack surface — critical since this app touches source code, git history, and potentially secrets.

### System / OS Layer — Rust Only
| Concern | Technology |
|---------|------------|
| File watching | OS-native watchers (fsevents / inotify / ReadDirectoryChangesW) |
| Git operations | `git2` (Rust bindings to libgit2) — diffs, status, branch/commit state |
| Process / PTY control | `portable-pty` — spawn/control CLI agents with full stdin/stdout/stderr |

### Local State — SQLite
Layers 1 and 2 both live in embedded SQLite — zero ops, fully local, no server dependency.

### Compression — Python + FastAPI
A local microservice on localhost doing LLM-based state compression with LangChain. The one layer where an LLM call is the tool, not the OS layer — kept isolated from the Rust core.

### Agent Communication — CLI Wrapping (PTY), Not Browser Automation
Claude Code, Codex CLI, and Gemini CLI are spawned as child processes inside a PTY controlled by the Rust core. The app injects handoff context as the opening input and passively observes terminal output for interruption detection and activity tracking.

### Why Not C for the OS Layer
Rust already provides C-level OS control with memory safety. Given direct access to source code, credentials, and shell execution, the security cost of C (buffer overflows, manual memory management, FFI complexity) outweighs any negligible performance gain. **One systems language, not two.**

---

## 6. Full Feature List

### Core Capture
- **F1 — PTY Session Capture:** Record every CLI agent session's stdin/stdout with timestamps and exit codes (Layer 1).
- **F2 — Session Archive:** Store raw sessions in SQLite, fully local.

### Structured Memory
- **F3 — Fact Extraction:** Derive structured facts from sessions: objective, decisions, failed attempts, constraints, changed files.
- **F4 — Project Memory Store:** Persist structured memory in SQLite (Layer 2).
- **F5 — Grounding Signals:** Cross-reference Git diffs, file mtimes, terminal output, test/build status to validate actual state.

### Context Compression
- **F6 — Snapshot Compression:** Compress structured state into a context-window-sized summary (Layer 3) via local LLM microservice.
- **F7 — Relevance Retrieval:** Retrieve only task-relevant state instead of sending an enormous history.

### Handoff
- **F8 — Provider Prompt Formatting:** Format compressed state into a provider-specific prompt (Layer 4).
- **F9 — Agent Launch:** Spawn the next agent with handoff context as opening input.
- **F10 — Handoff Card:** A summary of progress ("64% progress, 8 files changed, 3 errors remaining") with a "Continue with [agent]" action.

### UI — Live Activity Trace
- **F11 — Step Tree:** Render observed actions as a live, collapsible step tree (similar to Claude.ai tool-use blocks / Claude Code output).
- **F12 — Cross-Correlation:** Only show "wrote a file" when both parsed PTY output *and* the filesystem watcher confirm the change.
- **F13 — Headroom Collapsing:** Default collapsed state (only latest 2–3 steps expanded; older steps collapse to one summary line).
- **F14 — Reserved Outcome Space:** Live "what's happening now" line and handoff summary always keep guaranteed space.
- **F15 — Auto-Promotion:** On interruption, step data collapses directly into the handoff card — nothing re-derived.
- **F16 — Expand-on-Demand:** Click any collapsed group to re-expand its steps.

### Continuity Controls
- **F17 — Manual Interruption:** Explicit trigger producing a handoff card.
- **F18 — Continue With...:** Launch a second agent (e.g., Claude Code → Codex CLI) from the handoff card.
- **F19 — Automatic Failover (later):** Detect interruption and offer/proceed with failover.

### Security
- **F20 — Explicit Permissions:** Granular file/command/network permissions.
- **F21 — Sandboxing:** Isolate agent execution and bridge processes.
- **F22 — Secrets Protection:** Protect API keys, env vars, SSH config, credentials.
- **F23 — Encryption & Local Storage:** Encrypted local storage options.
- **F24 — Audit Logs:** Log actions for review; enterprise compliance-ready.
- **F25 — Data Policy Clarity:** Clear, documented data handling.

### Team / Enterprise (later)
- **F26 — Shared State:** Shared project state and handoffs for teams.
- **F27 — Roles & Permissions:** SSO, role-based access control.
- **F28 — Centralized Policies:** Organization-wide agent/compliance policies.
- **F29 — Self-Hosting:** Local/self-hosted deployment options.
- **F30 — Analytics & Auditability:** Usage, handoff, and audit reporting.

### Orchestration (long-term)
- **F31 — Model Routing:** Decide which agent should perform a task while preserving a single project state.
- **F32 — Multi-Model Workflow:** Planning with one model, coding with another, review with another, sensitive work with a local model.

---

## 7. Agent Adapters Roadmap

| Phase | Agent | Interface |
|-------|-------|-----------|
| MVP | Claude Code | PTY wrapper |
| MVP | Codex CLI | PTY wrapper |
| Phase 2 | Gemini CLI | PTY wrapper |
| Phase 2 | Local models (Ollama etc.) | CLI / local API |
| Later | Official APIs / MCP | Stable interfaces (preferred over browser automation) |
| Experimental only | Web chat (ChatGPT, Claude.ai) | Clipboard / extension autofill — **not** DOM scraping |

**Platform dependency principle:** Prioritize official APIs, supported integrations, CLI tools, and MCP wherever possible. Browser automation can be experimental, but must never be the core dependency.

---

## 8. Security Model

A local coding bridge may see source code, API keys, environment variables, databases, SSH configuration, private repositories, and customer data. A compromised bridge is extremely dangerous. Security is therefore a **product requirement, not an add-on**.

- **Explicit permissions** — user controls what the bridge and agents can access.
- **Sandboxing** — isolate agent and bridge execution.
- **File & command controls** — restrict which files/commands are accessible.
- **Secrets protection** — never log or leak keys/credentials.
- **Encryption** — encrypted local storage; encrypted transport where applicable.
- **Audit logs** — record actions for accountability.
- **Clear data policies** — documented local-first guarantees.
- **Enterprise-grade** (later): SSO, compliance controls, centralized policies.

---

## 9. Business Model & Market

### Target Customers
| Segment | Profile |
|---------|---------|
| **Initial** | AI-heavy individual developers who regularly use multiple coding agents; already feel the pain; adopt desktop tools quickly |
| **Next** | Professional teams needing shared context, handoffs, auditability, model choice |
| **Long-term** | Enterprises requiring self-hosted/local deployment, SSO, permissions, encryption, audit logs, compliance, private models, centralized policies |

### Pricing Tiers
| Tier | Price | Includes |
|------|-------|----------|
| **Free** | $0 | Basic local continuity, limited integrations |
| **Pro** | ~$10–$30/mo | Unlimited project memory, multiple providers, advanced handoffs, context management |
| **Team** | ~$20–$50+/user/mo | Shared state, permissions, analytics, audit |
| **Enterprise** | Custom | Self-hosting, security, SSO, compliance, dedicated support |

Prices must be validated through willingness-to-pay tests. The value proposition is **time saved and continuity**, not merely access to another AI.

### Competitive Landscape
Highly competitive: Claude Code, Codex, Gemini CLI, Cursor, Windsurf, Cline, Roo Code, Continue, Aider, and others are moving quickly. The opportunity is **not another coding agent** but a **neutral layer** that keeps work continuous across agents.

**Biggest competitive threat:** The AI providers themselves. OpenAI, Anthropic, and Google can build increasingly persistent agent environments, but they have little strategic incentive to make leaving their own ecosystem effortless. A neutral company has an incentive to connect competing ecosystems — this is the central strategic opportunity.

---

## 10. Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Platform dependency (browser automation)** | 10/10 | Use PTY/CLI, official APIs, MCP; browser automation experimental only |
| **Security / secret exposure** | 9/10 | Permissions, sandboxing, secrets protection, encryption, audit logs |
| **Limits disappear** (provider raises usage limits) | High | Limits are entry point only; continuity valued for switching, outages, context, privacy, cost, long tasks |
| **Initial defensibility** | 4/10 | Basic idea is copyable; build moat fast |
| **Potential defensibility** | 7/10 | Deep integrations, reliable state extraction, context compression, permissions, local security, workflow switching costs |
| **Technical difficulty (reliable continuation)** | 7/10 | Translation layer grounding Agent A state for Agent B against actual local project |
| **Competition** | 8/10 | Neutral-layer positioning; deep workflow integration |

---

## 11. MVP Scope & Success Criteria

### MVP In Scope
1. Tauri desktop shell — single monitored project folder.
2. Rust-based file watcher + git state extraction.
3. PTY wrapper for one agent: **Claude Code**.
4. SQLite-backed structured memory — **no compression service yet** (raw structured state is small enough to hand off directly at MVP scale).
5. Live activity tree UI with headroom-collapsing behavior.
6. Manual interruption trigger → handoff card → manual **"Continue with Codex CLI"** (second PTY adapter).

### MVP Out of Scope
- Compression/summarization service (Layer 3).
- Agents beyond Claude Code + Codex CLI.
- Team / enterprise features.
- Vector DB / search at scale.
- Browser automation / web chat.

### MVP Success Criterion
> A real interrupted coding task, picked up by the second agent, with the developer not having to re-explain the project.

Validate with 5–10 real developers before adding a third agent, compression service, or any team/enterprise features.

**Primary metric:** **Successful continuation rate** — out of 100 real interrupted tasks, how many can another agent continue without the developer re-explaining the project?

---

## 12. Phased Development Roadmap

### Phase 0 — Scaffold & Foundation
- Initialize Tauri project (`src` + `src-tauri`).
- Set up Rust core: `git2`, `portable-pty`, native fs watchers.
- SQLite schema for Layer 1 (Session Archive) and Layer 2 (Structured Memory).
- Scaffold compression-service (FastAPI + LangChain) skeleton.
- Repo conventions: lint, typecheck, CI.

### Phase 1 — MVP: Prove One Handoff
- PTY wrapper for Claude Code.
- File watcher + git state extraction.
- Structured memory + live activity tree UI with headroom collapsing.
- Manual interruption → handoff card → **Continue with Codex CLI**.
- **Exit gate:** successful continuation rate validated with 5–10 real developers.

### Phase 2 — Compression & More Agents
- Implement Layer 3 context compression (Python + FastAPI + LangChain).
- Add Gemini CLI adapter.
- Local model adapter (Ollama).
- Relevance retrieval for large memory volumes.
- **Exit gate:** multiple agents hand off with compressed context; memory scales.

### Phase 3 — Automatic Failover
- Detect interruptions automatically (crashes, hangs, provider errors, context-limit warnings).
- Auto-generate handoff and offer/proceed with failover.
- Reliable cross-agent state translation.
- **Exit gate:** automatic failover works without developer re-explanation.

### Phase 4 — Orchestration & Multi-Model Workflow
- Model routing: plan/code/review/research split across models.
- Single persistent project state across concurrent agents.
- **Exit gate:** orchestrator routes tasks while preserving one source of truth.

### Phase 5 — Team & Enterprise
- Shared project state, permissions, SSO, centralized policies.
- Audit logs, analytics, compliance controls.
- Self-hosted/local deployment.
- **Exit gate:** enterprise security + audit requirements met; team workflows validated.

---

## 13. Milestones & Definition of Done

| Milestone | Deliverable | Definition of Done |
|-----------|-------------|--------------------|
| **M0 — Scaffold** | Working Tauri shell + Rust core skeleton + SQLite schema | App launches; watcher & git state extraction run; schema migrates cleanly |
| **M1 — Capture** | Claude Code runs in PTY; activity trace renders | Session recorded to SQLite; steps shown in collapsible tree; file changes cross-validated |
| **M2 — Handoff** | Interruption → handoff card → Codex CLI continues | Codex CLI launched with context; developer does not re-explain; 5–10 devs validate |
| **M3 — Compression** | Layer 3 service live | Compressed snapshot fits fresh agent context window; relevance retrieval works |
| **M4 — Failover** | Automatic interruption detection + failover | Failover triggers correctly across Claude/Codex/Gemini; continuation rate measured |
| **M5 — Orchestration** | Multi-model routing with single state | Orchestrator routes tasks; state consistent across agents |
| **M6 — Enterprise** | Team/enterprise features shipped | SSO, permissions, audit, self-hosting validated with enterprise users |

---

## 14. Validation Metrics

| Metric | Definition | Target (Phase 1) |
|--------|-----------|------------------|
| **Successful continuation rate** | % of interrupted tasks another agent continues without re-explanation | High (validated with 5–10 devs) |
| **Weekly retained developers** | Devs using the bridge week-over-week | Positive trend |
| **Handoffs per user** | Avg. handoffs performed per user/week | Increasing |
| **Average time saved** | Dev-reported time saved per handoff | Positive, material |
| **Paid conversion** | Free → Pro conversion rate | Growing |
| **Multi-model usage** | % of users using 2+ providers | Growing |
| **User-reported trust** | Survey/feedback on trust in the bridge | High |

**Decision evidence:** The decisive evidence comes from real developers successfully handing off real unfinished tasks and choosing to keep the product after the novelty wears off.

---

## Bottom Line

Build the **AI continuity layer**, not the **AI limit bypass**.

The initial problem may be "my AI hit its limit." The eventual company could be much bigger: a neutral infrastructure layer that makes AI agents interchangeable while keeping the user's work continuous.

> **"Your AI can change. Your work doesn't."**
