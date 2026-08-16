import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { PowerIcon, RotateCcwIcon, SquareTerminalIcon } from "lucide-react";
import {
  claudeSpawn,
  observeDetect,
  observeStart,
  observeStop,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "../lib/bridge";
import type {
  ExternalSession,
  ObserveLine,
  ObserveStatus,
  PtyExit,
  PtyOverflow,
  PtyOutput,
  PtySpawned,
} from "../lib/types";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

interface TerminalPaneProps {
  cwd: string;
}

type Mode = "shell" | "claude" | "mirror";

const OBSERVE_STYLE: Record<string, string> = {
  text: "\x1b[0m",
  thinking: "\x1b[2m",
  tool: "\x1b[36m",
  error: "\x1b[31m",
  step: "\x1b[90m",
};

function writeObserveLine(term: Terminal, line: ObserveLine) {
  const color = OBSERVE_STYLE[line.kind] ?? "\x1b[0m";
  const prefix = line.kind === "thinking" ? "┈ " : "";
  for (const seg of line.text.split("\n")) {
    term.writeln(`${color}${prefix}${seg}\x1b[0m`);
  }
}

/**
 * Interactive terminal pane (M1.2 + M1.3 + M3): an xterm.js instance fed by
 * the raw PTY byte stream (pty://output) and typing straight into the
 * session's stdin (pty_write). "Claude Code" mode spawns the claude CLI in
 * the same session. "Mirror" mode (M3) is read-only: it tails an external
 * opencode session running in this project and streams its activity.
 */
export default function TerminalPane({ cwd }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [session, setSession] = useState<PtySpawned | null>(null);
  const [state, setState] = useState<"idle" | "running" | "exited">("idle");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [dropped, setDropped] = useState(0);
  const [mode, setMode] = useState<Mode>("shell");
  const [external, setExternal] = useState<ExternalSession | null>(null);
  const [observing, setObserving] = useState(false);
  const resizeTimer = useRef<number | undefined>(undefined);
  const modeRef = useRef<Mode>("shell");

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isMirror = mode === "mirror";
    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      cursorBlink: true,
      theme: { background: "#0d0d0d", foreground: "#e6e6e6" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;

    term.onData((data) => {
      if (!isMirror) ptyWrite(data).catch(() => {});
    });
    term.onResize(({ rows, cols }) => {
      window.clearTimeout(resizeTimer.current);
      resizeTimer.current = window.setTimeout(() => {
        ptyResize(rows, cols).catch(() => {});
      }, 80);
    });

    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(container);

    let unlistens: UnlistenFn[] = [];
    let disposed = false;

    const spawn = async () => {
      try {
        const rows = term.rows ?? 24;
        const cols = term.cols ?? 80;
        const info =
          modeRef.current === "claude"
            ? await claudeSpawn(cwd, rows, cols)
            : await ptySpawn(cwd, rows, cols);
        if (disposed) return;
        term.reset();
        setSession(info);
        setState("running");
        setExitCode(null);
        setDropped(0);
      } catch (e) {
        if (disposed) return;
        term.writeln(`\r\n\x1b[31mspawn failed: ${String(e)}\x1b[0m`);
        setState("idle");
      }
    };

    void (async () => {
      if (isMirror) {
        term.clear();
        term.writeln("\r\n\x1b[90m[mirror: external agent activity]\x1b[0m");
        unlistens = [
          await listen<ObserveLine>("observe://line", (e) => {
            if (disposed || modeRef.current !== "mirror") return;
            writeObserveLine(term, e.payload);
          }),
          await listen<ObserveStatus>("observe://status", (e) => {
            if (disposed) return;
            setObserving(e.payload.observing);
            if (e.payload.session) setExternal(e.payload.session);
          }),
          await listen<{ ended: boolean }>("observe://ended", () => {
            if (disposed) return;
            setObserving(false);
            term.writeln("\r\n\x1b[90m[mirror ended]\x1b[0m");
          }),
        ];
        setObserving(true);
        try {
          const s = await observeStart();
          if (disposed) return;
          setExternal(s);
        } catch (e) {
          if (disposed) return;
          setObserving(false);
          term.writeln(`\r\n\x1b[31mmirror failed: ${String(e)}\x1b[0m`);
          term.writeln(
            "\r\n\x1b[90m[start an opencode session in this project to mirror it here]\x1b[0m",
          );
        }
        return;
      }

      unlistens = [
        await listen<PtyOutput>("pty://output", (e) => {
          if (!disposed) term.write(e.payload.data);
        }),
        await listen<PtySpawned>("pty://spawned", (e) => {
          if (disposed) return;
          setSession(e.payload);
          setState("running");
          setExitCode(null);
        }),
        await listen<PtyExit>("pty://exit", (e) => {
          if (disposed) return;
          setState("exited");
          setExitCode(e.payload.code);
          term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
        }),
        await listen<PtyOverflow>("pty://overflow", (e) => {
          if (disposed) return;
          setDropped((d) => d + e.payload.dropped);
        }),
      ];
      await spawn();
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlistens) unlisten();
      ro.disconnect();
      window.clearTimeout(resizeTimer.current);
      term.dispose();
      termRef.current = null;
      if (isMirror) {
        void observeStop().catch(() => {});
      } else {
        void ptyKill().catch(() => {});
      }
    };
  }, [cwd, mode]);

  // Poll for an external opencode session while not mirroring, so the header
  // can advertise the Mirror tab even before the user opens it.
  useEffect(() => {
    if (mode === "mirror") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await observeDetect();
        if (!cancelled) setExternal(s);
      } catch {
        // backend not reachable; keep last known state
      }
    };
    void poll();
    const t = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [cwd, mode]);

  function restart() {
    termRef.current?.writeln("\r\n\x1b[90m[restarting]\x1b[0m");
    void ptyKill().catch(() => {});
    void spawnAgain();
  }

  async function spawnAgain() {
    const term = termRef.current;
    if (!term) return;
    try {
      const info = await ptySpawn(cwd, term.rows ?? 24, term.cols ?? 80);
      term.reset();
      setSession(info);
      setState("running");
      setExitCode(null);
      setDropped(0);
    } catch (e) {
      term.writeln(`\r\n\x1b[31mspawn failed: ${String(e)}\x1b[0m`);
      setState("idle");
    }
  }

  function toggleMirror() {
    const term = termRef.current;
    if (!term) return;
    if (observing) {
      setObserving(false);
      void observeStop().catch(() => {});
      term.writeln("\r\n\x1b[90m[mirror stopped]\x1b[0m");
    } else {
      term.clear();
      setObserving(true);
      term.writeln("\r\n\x1b[90m[mirror resumed]\x1b[0m");
      void observeStart()
        .then((s) => {
          if (modeRef.current === "mirror") setExternal(s);
        })
        .catch((e) => {
          setObserving(false);
          term.writeln(`\r\n\x1b[31mmirror failed: ${String(e)}\x1b[0m`);
        });
    }
  }

  const dirName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  const currentPath = session?.cwd ?? cwd;
  const sessionLabel =
    mode === "mirror"
      ? observing
        ? `mirroring · ${external?.title || external?.session_id.slice(0, 8) || "opencode"}`
        : "mirror idle"
      : state === "idle"
        ? "no session"
        : state === "running"
          ? `${session?.shell ?? "shell"} · ${dirName(currentPath)}`
          : `exited (${exitCode ?? "?"})`;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SquareTerminalIcon className="size-4 shrink-0 text-muted-foreground" />
          Terminal
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 rounded-full",
                observing
                  ? "animate-pulse bg-emerald-500"
                  : state === "running"
                    ? "animate-pulse bg-emerald-500"
                    : state === "exited"
                      ? "bg-zinc-500"
                      : "bg-zinc-700",
              )}
            />
            <span
              className="max-w-48 truncate text-xs font-normal text-muted-foreground"
              title={
                mode === "mirror"
                  ? `${external?.title} · ${external?.project_dir ?? ""}`
                  : currentPath
              }
            >
              {sessionLabel}
            </span>
          </span>
          {mode !== "mirror" && external && (
            <Badge
              variant="outline"
              className="max-w-44 truncate border-cyan-500/30 bg-cyan-500/10 text-cyan-400"
              title={`external ${external.backend} session · ${external.title || external.session_id} · ${external.project_dir}`}
            >
              {external.backend} · {external.title || external.session_id.slice(0, 8)}
            </Badge>
          )}
          {dropped > 0 && (
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-400"
              title="PTY buffer overflowed; output was dropped"
            >
              dropped {dropped} chunks
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {mode === "claude"
            ? "Claude Code CLI in this session"
            : mode === "mirror"
              ? "read-only mirror of the external agent session"
              : "plain shell session"}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="shell">Shell</TabsTrigger>
              <TabsTrigger value="claude">Claude Code</TabsTrigger>
              <TabsTrigger value="mirror">Mirror</TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "mirror" && (
            <Button
              size="sm"
              variant={observing ? "outline" : "default"}
              onClick={toggleMirror}
            >
              {observing ? "Stop mirror" : "Start mirror"}
            </Button>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={restart}
                  disabled={state === "idle" || mode === "mirror"}
                />
              }
            >
              <RotateCcwIcon />
            </TooltipTrigger>
            <TooltipContent>Restart session</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="destructive"
                  onClick={() => ptyKill().catch(() => {})}
                  disabled={mode === "mirror"}
                />
              }
            >
              <PowerIcon />
            </TooltipTrigger>
            <TooltipContent>Kill session</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 px-3 pb-3">
        <div className="h-[340px] overflow-hidden rounded-lg border border-border/60 bg-[#0d0d0d]">
          <div ref={containerRef} className="h-full w-full p-2" />
        </div>
      </CardContent>
    </Card>
  );
}