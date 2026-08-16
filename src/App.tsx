import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Table,
  TextField,
  Toast,
  toast,
} from "@heroui/react";
import {
  gitBranch,
  gitCommit,
  gitStatus,
  initDatabase,
  runCommand,
  setProjectRoot,
  shellWrite,
  spawnShell,
  startWatch,
} from "./lib/bridge";
import type { CommandOutput, GitFileStatus } from "./lib/types";

const NAV_ITEMS = ["Projects", "Sessions", "Git"] as const;

type ChipColor = "accent" | "danger" | "default" | "success" | "warning";

function statusColor(status: string): ChipColor {
  switch (status) {
    case "staged":
      return "success";
    case "modified":
      return "warning";
    case "deleted":
      return "danger";
    case "renamed":
      return "accent";
    default:
      return "default";
  }
}

/** A minimal "control center" shell demonstrating the Phase 0 Rust core. */
export default function App() {
  const [status, setStatus] = useState<GitFileStatus[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [output, setOutput] = useState<CommandOutput | null>(null);
  const [cmd, setCmd] = useState("git status");
  const [commitMsg, setCommitMsg] = useState("");

  const [dbPath, setDbPath] = useState("aicb.sqlite");
  const [rootPath, setRootPath] = useState("");
  const [rootSet, setRootSet] = useState(false);
  const [watching, setWatching] = useState(false);
  const [shellInput, setShellInput] = useState("");

  async function refreshGit() {
    try {
      setStatus(await gitStatus());
      setBranch(await gitBranch());
    } catch (e) {
      toast.danger(String(e));
    }
  }

  async function onInit() {
    try {
      const versions = await initDatabase(dbPath);
      toast.success(`db ready (${versions.join(", ")})`);
    } catch (e) {
      toast.danger(String(e));
    }
  }

  async function onBrowse() {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string" && picked) {
        setRootPath(picked);
        await setProjectRoot(picked);
        setRootSet(true);
        await refreshGit();
        toast.success(`root set: ${picked}`);
      }
    } catch (e) {
      toast.danger(String(e));
    }
  }

  async function onSetRoot() {
    const path = rootPath.trim();
    if (!path) {
      toast.danger("enter a project path first (must be a git repository)");
      return;
    }
    try {
      await setProjectRoot(path);
      setRootSet(true);
      await refreshGit();
      toast.success(`root set: ${path}`);
    } catch (e) {
      setRootSet(false);
      toast.danger(String(e));
    }
  }

  async function onRunCommand() {
    try {
      setOutput(await runCommand(cmd));
    } catch (e) {
      toast.danger(String(e));
    }
  }

  async function onCommit() {
    try {
      const oid = await gitCommit(commitMsg);
      setCommitMsg("");
      await refreshGit();
      toast.success(`committed ${oid.slice(0, 8)}`);
    } catch (e) {
      toast.danger(String(e));
    }
  }

  async function onStartWatch() {
    if (!rootSet) {
      toast.danger("set a project root before watching");
      return;
    }
    try {
      await startWatch();
      setWatching(true);
      toast.success("watching project folder");
    } catch (e) {
      toast.danger(String(e));
    }
  }

  async function onSpawnShell() {
    try {
      await spawnShell();
      toast.success("shell spawned");
    } catch (e) {
      toast.danger(String(e));
    }
  }

  async function onShellWrite() {
    try {
      await shellWrite(shellInput);
      setShellInput("");
      toast.success("sent to shell");
    } catch (e) {
      toast.danger(String(e));
    }
  }

  useEffect(() => {
    onInit();
    // Project root must point at a git repo — set it via the Setup panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dark min-h-screen bg-zinc-950 bg-[radial-gradient(1100px_600px_at_75%_-10%,rgba(139,92,246,0.14),transparent),radial-gradient(900px_550px_at_5%_110%,rgba(56,189,248,0.1),transparent)] text-zinc-100">
      <Toast.Provider />
      <div className="flex min-h-screen">
        <aside className="glass-sidebar flex w-60 shrink-0 flex-col gap-8 p-5">
          <div>
            <h1 className="app-display">Bridge</h1>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Your AI can change. Your work doesn't.
            </p>
          </div>
          <nav className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item}
                type="button"
                className="pressable rounded-lg px-3 py-2 text-left text-sm font-medium text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
              >
                {item}
              </button>
            ))}
          </nav>
          <div className="mt-auto flex flex-col gap-2 text-xs text-zinc-500">
            <div className="flex items-center gap-2">
              <span
                className={
                  watching
                    ? "status-dot h-2 w-2 rounded-full bg-emerald-500"
                    : "h-2 w-2 rounded-full bg-zinc-600"
                }
              />
              <span>{watching ? "watching" : "idle"}</span>
            </div>
            {branch && <span className="font-mono">branch: {branch}</span>}
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto">
          <header className="glass relative sticky top-0 z-20 flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <span className="app-eyebrow text-zinc-400">Control Center</span>
              {branch ? (
                <Chip size="sm" variant="soft" color="accent">
                  {branch}
                </Chip>
              ) : (
                <Chip size="sm" variant="soft">
                  no branch
                </Chip>
              )}
            </div>
            <div className="flex items-center gap-2">
              {watching && (
                <Chip size="sm" variant="soft" color="success">
                  watching
                </Chip>
              )}
              <Chip
                size="sm"
                variant="soft"
                color={rootSet ? "success" : "default"}
              >
                {rootSet ? "project set" : "no project"}
              </Chip>
            </div>
            <div className="edge-fade pointer-events-none absolute inset-x-0 top-full h-6" />
          </header>

          <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
            <Card>
              <Card.Header>
                <Card.Title>Setup</Card.Title>
                <Card.Description>
                  Point the bridge at your local database and project.
                </Card.Description>
              </Card.Header>
              <Card.Content className="flex flex-col gap-4">
                <TextField>
                  <Label>Database path</Label>
                  <Input
                    value={dbPath}
                    onChange={(e) => setDbPath(e.currentTarget.value)}
                  />
                </TextField>
                <TextField>
                  <Label>Project root</Label>
                  <Input
                    value={rootPath}
                    placeholder="path to a git repo"
                    onChange={(e) => setRootPath(e.currentTarget.value)}
                  />
                </TextField>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onPress={onBrowse}>
                    Browse…
                  </Button>
                  <Button variant="primary" size="sm" onPress={onSetRoot}>
                    Set root
                  </Button>
                  <Button variant="secondary" size="sm" onPress={onStartWatch}>
                    Watch
                  </Button>
                  <Button variant="ghost" size="sm" onPress={onInit}>
                    Init DB
                  </Button>
                </div>
              </Card.Content>
            </Card>

            <Card>
              <Card.Header>
                <Card.Title>Git status</Card.Title>
                <Card.Description>
                  {branch
                    ? `working tree on ${branch}`
                    : "set a project root to see changes"}
                </Card.Description>
              </Card.Header>
              <Card.Content>
                {status.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    No working-tree changes.
                  </p>
                ) : (
                  <Table>
                    <Table.ScrollContainer>
                      <Table.Content aria-label="Git status">
                        <Table.Header>
                          <Table.Column isRowHeader>File</Table.Column>
                          <Table.Column>Status</Table.Column>
                          <Table.Column>+/-</Table.Column>
                        </Table.Header>
                        <Table.Body>
                          {status.map((s) => (
                            <Table.Row key={s.path}>
                              <Table.Cell className="font-mono text-sm">
                                {s.path}
                              </Table.Cell>
                              <Table.Cell>
                                <Chip
                                  size="sm"
                                  variant="soft"
                                  color={statusColor(s.status)}
                                >
                                  {s.status}
                                </Chip>
                              </Table.Cell>
                              <Table.Cell className="font-mono text-sm">
                                <span className="text-emerald-400">
                                  +{s.additions}
                                </span>{" "}
                                <span className="text-red-400">
                                  -{s.deletions}
                                </span>
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Content>
                    </Table.ScrollContainer>
                  </Table>
                )}
              </Card.Content>
              <Card.Footer>
                <Button variant="ghost" size="sm" onPress={refreshGit}>
                  Refresh
                </Button>
              </Card.Footer>
            </Card>

            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <Card.Header>
                  <Card.Title>Commit</Card.Title>
                  <Card.Description>
                    Stage all changes and commit from the app.
                  </Card.Description>
                </Card.Header>
                <Card.Content className="flex flex-col gap-3">
                  <TextField>
                    <Label>Commit message</Label>
                    <Input
                      value={commitMsg}
                      placeholder="describe the change"
                      onChange={(e) => setCommitMsg(e.currentTarget.value)}
                      onKeyDown={(e) => e.key === "Enter" && onCommit()}
                    />
                  </TextField>
                  <Button variant="primary" fullWidth onPress={onCommit}>
                    Commit
                  </Button>
                </Card.Content>
              </Card>

              <Card>
                <Card.Header>
                  <Card.Title>Terminal</Card.Title>
                  <Card.Description>
                    Run a command in the project directory.
                  </Card.Description>
                </Card.Header>
                <Card.Content className="flex flex-col gap-3">
                  <div className="flex gap-2">
                    <Input
                      value={cmd}
                      placeholder="e.g. git status"
                      onChange={(e) => setCmd(e.currentTarget.value)}
                      onKeyDown={(e) => e.key === "Enter" && onRunCommand()}
                    />
                    <Button onPress={onRunCommand}>Run</Button>
                  </div>
                  {output && (
                    <pre className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-black/60 p-3 font-mono text-xs leading-relaxed text-zinc-300">
                      <span className="text-emerald-400">
                        $ {output.command}
                      </span>
                      {"\n"}
                      {output.output}
                      {"\n"}
                      <span className="text-zinc-500">
                        exit: {String(output.exit_code)}
                      </span>
                    </pre>
                  )}
                </Card.Content>
              </Card>
            </div>

            <Card>
              <Card.Header>
                <Card.Title>Interactive shell</Card.Title>
                <Card.Description>
                  Type into a live PTY shell running in the project.
                </Card.Description>
              </Card.Header>
              <Card.Content className="flex flex-col gap-3">
                <div>
                  <Button variant="outline" size="sm" onPress={onSpawnShell}>
                    Spawn shell
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={shellInput}
                    placeholder="input to the running shell"
                    onChange={(e) => setShellInput(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && onShellWrite()}
                  />
                  <Button onPress={onShellWrite}>Send</Button>
                </div>
              </Card.Content>
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}
