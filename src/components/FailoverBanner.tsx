import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertTriangleIcon,
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
import { Button } from "./ui/button";
import { toast } from "./ui/toast";

function fmtIdle(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

/**
 * Failover alerts promoted from the old panel into the global banner
 * stack: a stalled local agent, an interrupted session, or a dead web AI
 * needing a delivery target. Renders nothing when all is quiet — the
 * quiet local/web states live in the statusbar instead.
 */
export default function FailoverBanner() {
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

  async function deliver(
    target: "chatgpt" | "claudeai" | "gemini" | "grok" | "local",
  ) {
    try {
      await failoverDeliver(target);
      setWebEvent(null);
      toast.add({
        title: "Failover delivered",
        description:
          target === "local"
            ? "resuming locally — open your own terminal"
            : "handoff pushed to the paired browser",
        type: "success",
      });
    } catch (e) {
      toast.add({ title: "Failover failed", description: String(e) });
    }
  }

  const local = status?.local ?? "inactive";
  const empty =
    !(local === "stalled" && !localEvent) && !localEvent?.ok && !webEvent;
  if (empty) return null;

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-b border-border/60 bg-surface-2/60 px-4 py-2 text-xs">
      {local === "stalled" && !localEvent && (
        <div className="flex items-center gap-2">
          <AlertTriangleIcon className="size-4 shrink-0 text-warning" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            Your local terminal has been idle — if you stopped working, the
            bridge can continue automatically.
          </p>
          <Button variant="ghost" size="sm" onClick={() => dismiss("local")}>
            Keep working
          </Button>
        </div>
      )}

      {localEvent?.ok && (
        <div className="flex items-center gap-2">
          {localEvent.delivered ? (
            <SparklesIcon className="size-4 shrink-0 text-success" />
          ) : (
            <ShieldAlertIcon className="size-4 shrink-0 text-warning" />
          )}
          <p className="min-w-0 flex-1 font-medium">
            {localEvent.delivered
              ? "Local session interrupted — auto-continued on the web AI"
              : "Local session interrupted — no extension paired"}
            {localEvent.idle_ms != null && (
              <span className="ml-2 font-normal text-muted-foreground">
                after {fmtIdle(localEvent.idle_ms)}
              </span>
            )}
          </p>
          {!localEvent.delivered && (
            <span className="hidden text-muted-foreground md:inline">
              pair the extension to auto-continue next time
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => dismiss("local")}>
            Dismiss
          </Button>
        </div>
      )}

      {webEvent && (
        <div className="flex flex-col gap-2 py-1">
          <div className="flex items-center gap-2">
            <GlobeIcon className="size-4 shrink-0 text-warning" />
            <p className="min-w-0 flex-1 font-medium">
              Web AI session lost (
              {webEvent.trigger === "ws_drop" ? "disconnected" : "went idle"})
              <span className="ml-2 font-normal text-muted-foreground">
                after {fmtIdle(webEvent.idle_ms)}
              </span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <span className="mr-1 text-muted-foreground">continue on:</span>
            <Button size="sm" onClick={() => void deliver("chatgpt")}>
              ChatGPT
            </Button>
            <Button size="sm" onClick={() => void deliver("claudeai")}>
              Claude.ai
            </Button>
            <Button size="sm" onClick={() => void deliver("gemini")}>
              Gemini
            </Button>
            <Button size="sm" onClick={() => void deliver("grok")}>
              Grok
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void deliver("local")}
            >
              <HandIcon /> Local terminal
            </Button>
            <Button variant="ghost" size="sm" onClick={() => dismiss("web")}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
