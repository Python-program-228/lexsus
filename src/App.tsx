import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Chip } from "@heroui/react";
import {
  CircleAlertIcon,
  FolderIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import {
  getProjectRoot,
  pairGetCode,
  pairStatus,
  setProjectRoot,
  startWatch,
} from "./lib/bridge";
import ActivityTrace from "./components/ActivityTrace";
import BridgePanel from "./components/BridgePanel";
import GitPanel from "./components/GitPanel";
import HandoffPanel from "./components/HandoffPanel";
import TerminalPane from "./components/TerminalPane";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Separator } from "./components/ui/separator";
import { Skeleton } from "./components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";

const RECENTS_KEY = "lexsus.recentProjects";
const BROWSE_VALUE = "__browse__";

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function saveRecent(path: string) {
  const next = [path, ...loadRecents().filter((p) => p !== path)].slice(0, 8);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

/**
 * Control center shell (M1.2 + M2): sidebar (project root, pairing),
 * statusbar, and the milestone panels. Pairing state is owned here so
 * the sidebar and the BridgePanel share one source of truth.
 */
export default function App() {
  const [projectRoot, setRootInput] = useState("");
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [paired, setPaired] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    void (async () => {
      try {
        const [saved, code, isPaired] = await Promise.all([
          getProjectRoot(),
          pairGetCode().catch(() => ""),
          pairStatus().catch(() => false),
        ]);
        if (saved) {
          setRootInput(saved);
          saveRecent(saved);
          setRecents(loadRecents());
          await startWatch();
        }
        setPairCode(code);
        setPaired(isPaired);
        unlistens = [
          await listen<string>("pair://code", (e) => setPairCode(e.payload)),
          await listen<boolean>("pair://status", (e) => setPaired(e.payload)),
        ];
      } catch (e) {
        setError(String(e));
      } finally {
        setRestored(true);
      }
    })();
    return () => {
      for (const u of unlistens) u();
    };
  }, []);

  async function applyProject(path: string) {
    try {
      await setProjectRoot(path);
      await startWatch();
      setError("");
      saveRecent(path);
      setRecents(loadRecents());
    } catch (e) {
      setError(String(e));
    }
  }

  async function onBrowse() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select project folder",
      });
      if (typeof selected === "string" && selected) {
        setRootInput(selected);
        await applyProject(selected);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function onSelectProject(value: string | null) {
    if (!value) return;
    if (value === BROWSE_VALUE) {
      void onBrowse();
      return;
    }
    setRootInput(value);
    void applyProject(value);
  }

  const selectItems =
    projectRoot && !recents.includes(projectRoot)
      ? [projectRoot, ...recents]
      : recents;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      <aside className="glass-sidebar flex w-60 shrink-0 flex-col gap-5 p-4">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <TerminalIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm leading-tight font-semibold">
              Continuity Bridge
            </p>
            <p className="text-[11px] text-muted-foreground">
              local · AI control center
            </p>
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <p className="app-eyebrow text-muted-foreground">Project</p>
          <Label htmlFor="project-root">Working directory</Label>
          <div className="flex gap-2">
            <Select
              value={projectRoot || undefined}
              onValueChange={onSelectProject}
            >
              <SelectTrigger
                size="sm"
                className="w-full min-w-0 flex-1 font-mono text-xs"
                aria-label="Pick a folder"
              >
                <SelectValue placeholder="Pick a folder…" />
              </SelectTrigger>
              <SelectContent align="start" className="max-w-72">
                <SelectGroup>
                  {selectItems.length === 0 ? (
                    <SelectItem value="__empty__" disabled>
                      No folders yet
                    </SelectItem>
                  ) : (
                    selectItems.map((p) => (
                      <SelectItem key={p} value={p}>
                        <FolderIcon className="shrink-0 text-muted-foreground" />
                        <span className="truncate font-mono text-xs">{p}</span>
                      </SelectItem>
                    ))
                  )}
                </SelectGroup>
                <SelectSeparator />
                <SelectItem value={BROWSE_VALUE}>
                  <FolderOpenIcon className="shrink-0 text-muted-foreground" />
                  Browse folder…
                </SelectItem>
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void onBrowse()}
                    aria-label="Browse for a folder"
                  />
                }
              >
                <FolderOpenIcon />
              </TooltipTrigger>
              <TooltipContent>Browse for a folder</TooltipContent>
            </Tooltip>
          </div>
          {projectRoot ? (
            <p
              className="truncate text-[11px] text-muted-foreground"
              title={projectRoot}
            >
              {projectRoot}
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {restored
                ? "Pick a recent folder or browse to unlock the terminal, trace and git."
                : "restoring…"}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="app-eyebrow text-muted-foreground">Pairing</p>
          <div className="flex items-center justify-between">
            <Chip
              color={paired ? "success" : "default"}
              variant="soft"
              size="sm"
            >
              {paired ? "Paired" : "Unpaired"}
            </Chip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Refresh pairing"
                  />
                }
              >
                <RefreshCwIcon />
              </TooltipTrigger>
              <TooltipContent>6-digit code for the extension popup</TooltipContent>
            </Tooltip>
          </div>
          {pairCode ? (
            <code className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-center font-mono text-lg tracking-[0.35em] text-foreground">
              {pairCode}
            </code>
          ) : (
            <p className="rounded-md border border-dashed border-border px-2 py-1.5 text-center text-[11px] leading-relaxed text-muted-foreground">
              Pair from the extension popup — the code appears here.
            </p>
          )}
        </div>

        <div className="mt-auto">
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-40" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            bridge online
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="app-eyebrow text-muted-foreground">Control center</p>
            <h1 className="app-display">
              {projectRoot ? "Session active" : "Awaiting project"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Chip color={projectRoot ? "accent" : "default"} variant="soft" size="sm">
              {projectRoot ? "tauri · npm · rust" : "idle"}
            </Chip>
          </div>
        </header>

        {error && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription className="font-mono text-xs">
              {error}
            </AlertDescription>
          </Alert>
        )}

        {!restored ? (
          <div className="grid grid-cols-12 gap-4">
            <Skeleton className="col-span-12 h-40 lg:col-span-5" />
            <Skeleton className="col-span-12 h-40 lg:col-span-7" />
            <Skeleton className="col-span-12 h-80 lg:col-span-7" />
            <Skeleton className="col-span-12 h-80 lg:col-span-5" />
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-4">
            <div className="col-span-12 lg:col-span-5">
              <HandoffPanel />
            </div>
            <div className="col-span-12 lg:col-span-7">
              <BridgePanel code={pairCode} connected={paired} />
            </div>
            <div className="col-span-12 lg:col-span-7">
              {projectRoot ? (
                <TerminalPane cwd={projectRoot} />
              ) : (
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <TerminalIcon className="size-4 text-muted-foreground" />
                      Terminal
                    </CardTitle>
                    <CardDescription>no session yet</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Empty className="min-h-64 border-0">
                      <EmptyMedia variant="icon">
                        <TerminalIcon />
                      </EmptyMedia>
                      <EmptyContent>
                        <EmptyHeader>
                          <EmptyTitle>Terminal locked</EmptyTitle>
                          <EmptyDescription>
                            Pick a folder from the sidebar to start the
                            interactive terminal.
                          </EmptyDescription>
                        </EmptyHeader>
                      </EmptyContent>
                    </Empty>
                  </CardContent>
                </Card>
              )}
            </div>
            <div className="col-span-12 lg:col-span-5">
              <ActivityTrace />
            </div>
            <div className="col-span-12">
              <GitPanel />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}