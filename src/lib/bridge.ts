import { invoke } from "@tauri-apps/api/core";
import type { CommandOutput, GitFileStatus } from "./types";

/** Thin typed wrapper around the Rust core's Tauri commands. */

export function initDatabase(dbPath: string): Promise<string[]> {
  return invoke("init_database", { dbPath });
}

export function setProjectRoot(path: string): Promise<void> {
  return invoke("set_project_root", { path });
}

export function gitStatus(): Promise<GitFileStatus[]> {
  return invoke("git_status");
}

export function gitBranch(): Promise<string | null> {
  return invoke("git_branch");
}

export function gitCommit(message: string): Promise<string> {
  return invoke("git_commit", { message });
}

export function runCommand(command: string): Promise<CommandOutput> {
  return invoke("run_command", { command });
}

export function startWatch(): Promise<void> {
  return invoke("start_watch");
}

export function spawnShell(): Promise<string> {
  return invoke("spawn_shell");
}

export function shellWrite(input: string): Promise<void> {
  return invoke("shell_write", { input });
}
