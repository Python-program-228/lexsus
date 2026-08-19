import { useEffect, useState } from "react";
import {
  ProgressBar,
  ProgressBarFill,
  ProgressBarTrack,
  Spinner,
} from "@heroui/react";
import {
  ClipboardIcon,
  LightbulbIcon,
  MessageCircleIcon,
  RotateCcwIcon,
} from "lucide-react";
import { buildHandoff, handoffSend, setObjective } from "../lib/bridge";
import type { Handoff } from "../lib/types";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Separator } from "./ui/separator";
import { toast } from "./ui/toast";

/** Handoff card (M2): build real state → "Continue with ChatGPT".
 *  Sends the payload to the paired extension (which renders it on
 *  chatgpt.com); falls back to clipboard copy. */
export default function HandoffPanel() {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [objective, setObj] = useState("");
  const [status, setStatus] = useState("");
  const [built, setBuilt] = useState(false);

  async function build() {
    const h = await buildHandoff();
    setHandoff(h);
    setObj(h.objective);
    setBuilt(true);
  }

  async function continueWithChatGPT() {
    if (!handoff) return;
    await setObjective(objective).catch(() => {});
    const h = await handoffSend();
    setStatus(
      h.generated_at
        ? "handoff sent to the extension — open chatgpt.com"
        : "",
    );
    await navigator.clipboard.writeText(handoffText(h)).catch(() => {});
    setStatus("handoff sent to the extension (also copied to clipboard)");
    toast.add({
      title: "Handoff sent",
      description: "Open chatgpt.com in the paired browser to continue.",
      type: "success",
    });
  }

  function handoffText(h: Handoff): string {
    return [
      `# Continue this task (AI Continuity Bridge handoff)`,
      ``,
      `Objective: ${h.objective}`,
      `Progress: ${h.progress_percent}% · Files changed: ${h.files_changed} · Errors remaining: ${h.errors_remaining}`,
      `Next step: ${h.next_step ?? "review state"}`,
      h.files.length > 0 ? `Files involved: ${h.files.join(", ")}` : "",
      ``,
      `You are now the coding agent for the local project at the paired machine.`,
      `You may request file reads, file writes, and command runs; the bridge executes them locally and returns real results.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  useEffect(() => {
    void build();
  }, []);

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageCircleIcon className="size-4 shrink-0 text-muted-foreground" />
          Handoff → ChatGPT
        </CardTitle>
        <CardDescription>built from real trace + watcher state</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {handoff ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="objective">Objective</Label>
              <Input
                id="objective"
                value={objective}
                onChange={(e) => setObj(e.currentTarget.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-mono">{handoff.progress_percent}%</span>
              </div>
              <ProgressBar
                value={handoff.progress_percent}
                color="accent"
                aria-label="Handoff progress"
              >
                <ProgressBarTrack className="h-1.5">
                  <ProgressBarFill />
                </ProgressBarTrack>
              </ProgressBar>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">
                  Files changed
                </span>
                <span className="font-mono text-sm font-semibold">
                  {handoff.files_changed}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <span className="text-[11px] text-muted-foreground">
                  Errors remaining
                </span>
                <span className="font-mono text-sm font-semibold">
                  {handoff.errors_remaining}
                </span>
              </div>
              <div className="col-span-2 flex flex-col gap-0.5 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 sm:col-span-1">
                <span className="text-[11px] text-muted-foreground">State</span>
                <span className="font-mono text-sm font-semibold text-muted-foreground">
                  {handoff.errors_remaining > 0 ? "in progress" : "on track"}
                </span>
              </div>
            </div>

            {handoff.next_step && (
              <p className="text-xs text-muted-foreground">
                next step: {handoff.next_step}
              </p>
            )}

            {handoff.end_reason && (
              <p className="text-[11px] text-muted-foreground">
                {handoff.end_reason}
              </p>
            )}

            {handoff.context && (
              <details className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <summary className="cursor-pointer text-[11px] text-muted-foreground">
                  task context (from your Claude Code transcript)
                </summary>
                <p className="mt-1 text-xs leading-relaxed text-foreground/80">
                  {handoff.context}
                </p>
              </details>
            )}

            <Separator />

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void continueWithChatGPT()}>
                <MessageCircleIcon /> Continue with ChatGPT
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(handoffText(handoff!))
                    .then(() =>
                      toast.add({
                        title: "Copied",
                        description: "handoff text is on your clipboard",
                        type: "success",
                      }),
                    )
                }
              >
                <ClipboardIcon /> Copy handoff
              </Button>
              <Button variant="ghost" onClick={() => void build()}>
                <RotateCcwIcon /> Rebuild
              </Button>
            </div>

            {status && <p className="text-xs text-emerald-400">{status}</p>}

            {built && !handoff.files_changed && (
              <Alert>
                <LightbulbIcon />
                <AlertTitle>Tip</AlertTitle>
                <AlertDescription>
                  Run a Claude Code session first — the card is built from what
                  it did.
                </AlertDescription>
              </Alert>
            )}
          </>
        ) : (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner size="sm" /> building handoff…
          </div>
        )}
      </CardContent>
    </Card>
  );
}