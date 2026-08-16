import { invoke } from "@tauri-apps/api/core";
import type {
  AuditEntry,
  BranchInfo,
  BridgeTool,
  CommandOutput,
  CommitInfo,
  ExternalSession,
  FileDiff,
  GitFileStatus,
  Handoff,
  PtySpawned,
  ToolResult,
  TraceStep,
} from "./types";

/** Thin typed wrapper around the Rust core's Tauri commands. */

export function initDatabase(dbPath: string): Promise<string[]> {
  return invoke("init_database", { dbPath });
}

export function setProjectRoot(path: string): Promise<void> {
  return invoke("set_project_root", { path });
}

export function getProjectRoot(): Promise<string | null> {
  return invoke("get_project_root");
}

// --- git ---------------------------------------------------------------------

export function gitStatus(): Promise<GitFileStatus[]> {
  return invoke("git_status");
}

export function gitBranch(): Promise<string | null> {
  return invoke("git_branch");
}

export function gitCommit(message: string): Promise<string> {
  return invoke("git_commit", { message });
}

export function gitDiff(): Promise<FileDiff[]> {
  return invoke("git_diff");
}

export function gitStage(path: string): Promise<void> {
  return invoke("git_stage", { path });
}

export function gitUnstage(path: string): Promise<void> {
  return invoke("git_unstage", { path });
}

export function gitStageAll(): Promise<void> {
  return invoke("git_stage_all");
}

export function gitBranches(): Promise<BranchInfo[]> {
  return invoke("git_branches");
}

export function gitCheckout(name: string): Promise<void> {
  return invoke("git_checkout", { name });
}

export function gitLog(limit?: number): Promise<CommitInfo[]> {
  return invoke("git_log", { limit });
}

export function gitCommitDiff(oid: string): Promise<string> {
  return invoke("git_commit_diff", { oid });
}

// --- one-shot command + PTY --------------------------------------------------

export function runCommand(
  command: string,
  timeoutMs?: number,
  maxOutputBytes?: number,
): Promise<CommandOutput> {
  return invoke("run_command", {
    command,
    timeoutMs,
    maxOutputBytes,
  });
}

/** Interactive PTY session (terminal pane). Events arrive on pty://* channels. */
export function ptySpawn(cwd: string, rows: number, cols: number): Promise<PtySpawned> {
  return invoke("pty_spawn", { cwd, rows, cols });
}

/** Claude Code session (M1.3). */
export function claudeSpawn(cwd: string, rows: number, cols: number): Promise<PtySpawned> {
  return invoke("claude_spawn", { cwd, rows, cols });
}

export function ptyWrite(data: string): Promise<void> {
  return invoke("pty_write", { data });
}

export function ptyResize(rows: number, cols: number): Promise<void> {
  return invoke("pty_resize", { rows, cols });
}

export function ptyKill(): Promise<void> {
  return invoke("pty_kill");
}

// --- watcher -----------------------------------------------------------------

export function startWatch(): Promise<void> {
  return invoke("start_watch");
}

// --- M3 external session mirror ----------------------------------------------

export function observeDetect(): Promise<ExternalSession | null> {
  return invoke("observe_detect");
}

export function observeStart(): Promise<ExternalSession> {
  return invoke("observe_start");
}

export function observeStop(): Promise<void> {
  return invoke("observe_stop");
}

// --- M2 bridge ---------------------------------------------------------------

export function bridgeTool(tool: BridgeTool): Promise<ToolResult> {
  return invoke("bridge_tool", { tool });
}

export function shellWrite(input: string): Promise<void> {
  return invoke("shell_write", { input });
}
export function bridgeApprove(id: number, allow: boolean): Promise<ToolResult> {
  return invoke("bridge_approve", { id, allow });
}

export function bridgeAudit(limit?: number): Promise<AuditEntry[]> {
  return invoke("bridge_audit", { limit });
}

export function pairGetCode(): Promise<string> {
  return invoke("pair_get_code");
}

export function pairStatus(): Promise<boolean> {
  return invoke("pair_status");
}

export function setObjective(text: string): Promise<void> {
  return invoke("set_objective", { text });
}

export function buildHandoff(): Promise<Handoff> {
  return invoke("build_handoff");
}

export function handoffSend(): Promise<Handoff> {
  return invoke("handoff_send");
}

export type { TraceStep };
