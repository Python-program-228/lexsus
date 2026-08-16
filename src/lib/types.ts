// Shared types mirroring the Rust core's serde structs.

export interface GitFileStatus {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface CommandOutput {
  command: string;
  exit_code: number | null;
  output: string;
  timed_out: boolean;
  truncated: boolean;
}

export interface PtySpawned {
  shell: string;
  cwd: string;
}

export interface PtyOutput {
  data: string;
}

export interface PtyExit {
  code: number | null;
}

export interface PtyOverflow {
  dropped: number;
}

export interface FsEvent {
  path: string;
  kind: string;
}

// --- M1.4 activity trace -----------------------------------------------------

export interface TraceStep {
  kind: string; // reading | editing | running | test | error
  file: string | null;
  command: string | null;
  detail: string | null;
  confirmed: boolean;
  agent: string; // claude | web
  ts: number;
}

// --- M1.6 git panel ----------------------------------------------------------

export interface FileDiff {
  path: string;
  status: string;
  added: number;
  deleted: number;
  patch: string;
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: string;
  timestamp: number;
}

// --- M2 bridge ---------------------------------------------------------------

export interface BridgeTool {
  ReadFile?: { path: string };
  WriteFile?: { path: string; content: string };
  RunCommand?: { command: string };
  ListDirectory?: { path: string };
  GitStatus?: null;
}

export interface ToolResult {
  ok: boolean;
  output: string | null;
  error: string | null;
  pending: string | null;
}

export interface ApprovalRequested {
  id: number;
  summary: string;
  source: string;
}

export interface AuditEntry {
  agent: string;
  tool: string;
  args: string;
  allowed: boolean;
  approved_by: string;
  ok: boolean;
  ts: string;
}

// --- M2 handoff --------------------------------------------------------------

export interface Handoff {
  objective: string;
  progress_percent: number;
  files_changed: number;
  errors_remaining: number;
  next_step: string | null;
  files: string[];
  generated_at: string;
}