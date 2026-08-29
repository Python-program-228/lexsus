import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangleIcon,
  ArrowLeftRightIcon,
  GlobeIcon,
  HandIcon,
  ShieldAlertIcon,
  SparklesIcon,
} from "lucide-react";
import {
  failoverDeliver,
  failoverReset,
  failoverStatus,
} from "../lib/bridge";
import type {
  FailoverLocalEvent,
  FailoverStatus,
  FailoverWebEvent,
} from "../lib/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { toast } from "./ui/toast";

function fmtIdle(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

function stateBadge(state: string): {
  variant: "default" | "secondary" | "destructive" | "outline" | "ghost";
  className: string;
} {
  switch (state) {
    case "interrupted":
      return { variant: "destructive", className: "" };
    case "stalled":
      return { variant: "outline", className: "text-amber-400" };
    case "working":
      return { variant: "secondary", className: "text-emerald-500" };
    default:
      return { variant: "ghost", className: "" };
  }
}

/**
 * Automatic failover (Phase 3): surface the failover state machines and
 * the two cards — local agent interrupted (auto-continued on the web AI,
 * or unpaired) and web AI died mid-work (offer Claude.ai/Gemini/local).
 */
export default function FailoverPanel() {
  const [status, setStatus] = useState<FailoverStatus | null>(null);
  const [localEvent, setLocalEvent] = useState<FailoverLocalEvent | null>(null);
  const [webEvent, setWebEvent] = useState<FailoverWebEvent | null>(null);

  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    void (async () => {
      try {
        setStatus(await failoverStatus());
      } catch {
        /* not ready */
      }
      unlistens = [
        await listen<FailoverStatus>("failover://status", (e) =>
          setStatus(e.payload),
        ),
        await listen<FailoverLocalEvent>("failover://local", (e) =>
          setLocalEvent(e.payload),
        ),
        await listen<FailoverWebEvent>("failover://web", (e) =>
          setWebEvent(e.payload),
        ),
      ];
    })();
    return () => {
      for (const u of unlistens) u();
    };
  }, []);

  function dismiss(agent: "local" | "web") {
    void failoverReset(agent).then(() => {
      if (agent === "local") setLocalEvent(null);
      else setWebEvent(null);
    });
  }

  async function deliver(target: "chatgpt" | "claudeai" | "gemini" | "grok" | "local") {
    try {
      await failoverDeliver(target);
      setWebEvent(null);
      toast.add({
        title: "Failover delivered",
        description:
          target === "local"
            ? "resuming locally — open your own terminal"
            : `handoff pushed to the paired browser`,
        type: "success",
      });
    } catch (e) {
      toast.add({ title: "Failover failed", description: String(e) });
    }
  }

  const local = status?.local ?? "inactive";
  const web = status?.web ?? "inactive";

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowLeftRightIcon className="size-4 shrink-0 text-muted-foreground" />
          Automatic failover
        </CardTitle>
        <CardDescription>
          detects a stopped local agent and a dead web AI — continues the
          task without re-explanation
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">local</span>
          <Badge variant={stateBadge(local).variant} className={stateBadge(local).className}>
            {local}
          </Badge>
          <span className="text-muted-foreground">web</span>
          <Badge variant={stateBadge(web).variant} className={stateBadge(web).className}>
            {web}
          </Badge>
          {(local === "stalled" || web === "stalled") && (
            <span className="ml-auto text-muted-foreground">
              idle {fmtIdle(Math.max(status?.local_idle_ms ?? 0, status?.web_idle_ms ?? 0))}
            </span>
          )}
        </div>

        {local === "stalled" && !localEvent && (
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <AlertTriangleIcon className="size-4 shrink-0 text-amber-400" />
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              Your local terminal has been idle — if you stopped working,
              the bridge can continue automatically.
            </p>
            <Button variant="ghost" size="sm" onClick={() => dismiss("local")}>
              Keep working
            </Button>
          </div>
        )}

        {localEvent?.ok && (
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
            <div className="flex items-center gap-2">
              {localEvent.delivered ? (
                <SparklesIcon className="size-4 shrink-0 text-emerald-400" />
              ) : (
                <ShieldAlertIcon className="size-4 shrink-0 text-amber-400" />
              )}
              <p className="text-xs font-medium">
                {localEvent.delivered
                  ? "Local session interrupted — auto-continued on ChatGPT"
                  : "Local session interrupted — no extension paired"}
              </p>
              {localEvent.idle_ms != null && (
                <span className="ml-auto text-[11px] text-muted-foreground">
                  after {fmtIdle(localEvent.idle_ms)}
                </span>
              )}
            </div>
            {!localEvent.delivered && (
              <p className="text-xs text-muted-foreground">
                Open the browser extension popup and pair it — the next
                interruption will continue automatically.
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => dismiss("local")}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {webEvent && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
            <div className="flex items-center gap-2">
              <GlobeIcon className="size-4 shrink-0 text-amber-400" />
              <p className="text-xs font-medium">
                Web AI session lost ({webEvent.trigger === "ws_drop" ? "disconnected" : "went idle"})
              </p>
              <span className="ml-auto text-[11px] text-muted-foreground">
                after {fmtIdle(webEvent.idle_ms)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Continue the same task on another web AI, or pick it up in your
              own terminal.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void deliver("claudeai")}>
                Continue on Claude.ai
              </Button>
              <Button size="sm" onClick={() => void deliver("gemini")}>
                Continue on Gemini
              </Button>
              <Button size="sm" onClick={() => void deliver("grok")}>
                Continue on Grok
              </Button>
              <Button variant="outline" size="sm" onClick={() => void deliver("local")}>
                <HandIcon /> Hand back to local
              </Button>
              <Button variant="ghost" size="sm" onClick={() => dismiss("web")}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {(local === "inactive" && !localEvent && !webEvent) && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Idle detection: ~1.5 min of no local activity warns, ~5 min
            confirms and auto-continues. Any local file change cancels it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}