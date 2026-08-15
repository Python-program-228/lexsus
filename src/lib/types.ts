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
}

export interface FsEvent {
  path: string;
  kind: string;
}

export interface Handoff {
  objective?: string;
  progressPercent: number;
  filesChanged: number;
  errorsRemaining: number;
  nextStep?: string;
}
