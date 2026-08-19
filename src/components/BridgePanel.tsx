import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Chip } from "@heroui/react";
import {
  CheckIcon,
  ChevronDownIcon,
  GlobeIcon,
  XIcon,
} from "lucide-react";
import { bridgeApprove, bridgeAudit, bridgeTool } from "../lib/bridge";
import type {
  ApprovalRequested,
  AuditEntry,
  BridgeTool,
  ToolResult,
} from "../lib/types";
import { cn } from "../lib/utils";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "./ui/alert";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import { toast } from "./ui/toast";

interface Approval extends ApprovalRequested {
  id: number;
  resolving?: boolean;
}

interface BridgePanelProps {
  code: string;
  connected: boolean;
}

/** Bridge panel (M2): extension pairing, web-AI approval queue, a tool
 *  sandbox for testing read/write/run locally, and the audit trail. */
export default function BridgePanel({ code, connected }: BridgePanelProps) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [readPath, setReadPath] = useState("src/App.tsx");
  const [writePath, setWritePath] = useState("");
  const [writeContent, setWriteContent] = useState("");
  const [command, setCommand] = useState("git status");
  const [sandbox, setSandbox] = useState<ToolResult | null>(null);

  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    void (async () => {
      setAudit(await bridgeAudit(20).catch(() => []));
      unlistens = [
        await listen<ApprovalRequested>("bridge://approval-requested", (e) => {
          setApprovals((prev) => [
            { ...e.payload, id: e.payload.id },
            ...prev.filter((p) => p.id !== e.payload.id),
          ]);
        }),
        await listen<{ id: number }>("bridge://approval-resolved", (e) => {
          setApprovals((prev) => prev.filter((p) => p.id !== e.payload.id));
        }),
      ];
    })();
    return () => {
      for (const u of unlistens) u();
    };
  }, []);

  async function decide(id: number, allow: boolean) {
    setApprovals((prev) =>
      prev.map((p) => (p.id === id ? { ...p, resolving: true } : p)),
    );
    await bridgeApprove(id, allow).catch(() => {});
    setAudit(await bridgeAudit(20).catch(() => []));
    toast.add({
      title: allow ? "Request allowed" : "Request denied",
      description: `#${id} recorded to the audit trail`,
      type: allow ? "success" : "info",
    });
  }

  async function sandboxRun(tool: BridgeTool) {
    setSandbox(await bridgeTool(tool));
    setAudit(await bridgeAudit(20).catch(() => []));
  }

  const sectionClass = "flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground";

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
          Web-AI Bridge
        </CardTitle>
        <CardDescription>
          {connected ? "extension paired" : "no extension paired"}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Chip
            color={connected ? "success" : "default"}
            variant="soft"
            size="sm"
          >
            {connected ? "Paired" : "Offline"}
          </Chip>
          {code ? (
            <code className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-sm tracking-[0.2em]">
              {code}
            </code>
          ) : (
            <span className="text-xs text-muted-foreground">no code</span>
          )}
        </CardAction>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
        {approvals.length > 0 && (
          <div className="flex flex-col gap-2">
            {approvals.map((a) => (
              <Alert key={a.id} className="pr-28">
                <GlobeIcon />
                <AlertTitle className="flex items-center gap-1.5">
                  {a.source === "web" ? "ChatGPT" : "Desktop"} requests:{" "}
                  {a.summary}
                </AlertTitle>
                <AlertDescription>
                  Approve to let the agent run this locally on this machine.
                </AlertDescription>
                <AlertAction className="flex gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => void decide(a.id, true)}
                    disabled={a.resolving}
                  >
                    <CheckIcon /> Allow
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => void decide(a.id, false)}
                    disabled={a.resolving}
                  >
                    <XIcon /> Deny
                  </Button>
                </AlertAction>
              </Alert>
            ))}
          </div>
        )}

        <Collapsible className="flex flex-col gap-2">
          <CollapsibleTrigger className={sectionClass}>
            Tool sandbox (test read / write / run locally)
            <ChevronDownIcon className="size-4" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="flex items-end gap-2">
                <Label className="shrink-0 text-[11px] text-muted-foreground">
                  read_file
                </Label>
                <Input
                  value={readPath}
                  onChange={(e) => setReadPath(e.currentTarget.value)}
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void sandboxRun({ ReadFile: { path: readPath } })}
                >
                  Read
                </Button>
              </div>
              <div className="flex items-end gap-2">
                <Label className="shrink-0 text-[11px] text-muted-foreground">
                  write_file
                </Label>
                <Input
                  value={writePath}
                  placeholder="path"
                  onChange={(e) => setWritePath(e.currentTarget.value)}
                  className="font-mono text-xs"
                />
                <Input
                  value={writeContent}
                  placeholder="content"
                  onChange={(e) => setWriteContent(e.currentTarget.value)}
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() =>
                    void sandboxRun({
                      WriteFile: { path: writePath, content: writeContent },
                    })
                  }
                >
                  Write
                </Button>
              </div>
              <div className="flex items-end gap-2">
                <Label className="shrink-0 text-[11px] text-muted-foreground">
                  run_command
                </Label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.currentTarget.value)}
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void sandboxRun({ RunCommand: { command } })}
                >
                  Run
                </Button>
              </div>
              {sandbox && (
                <ScrollArea className="h-28 rounded-md border border-border/60 bg-background/60 p-3">
                  <pre
                    className={cn(
                      "font-mono text-[11px] leading-relaxed",
                      sandbox.ok ? "text-foreground" : "text-red-400",
                    )}
                  >
                    {sandbox.ok
                      ? sandbox.output
                      : sandbox.error ?? sandbox.pending ?? "?"}
                  </pre>
                </ScrollArea>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        <Collapsible className="flex flex-col gap-2">
          <CollapsibleTrigger className={sectionClass}>
            Audit trail (last {audit.length})
            <ChevronDownIcon className="size-4" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ScrollArea className="h-32 rounded-lg border border-border/60 bg-muted/20 p-3">
              {audit.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No tool calls recorded yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {audit.map((a, i) => (
                    <li
                      key={i}
                      className={cn(
                        "flex gap-2 font-mono text-[11px]",
                        !a.allowed && "text-red-400",
                      )}
                    >
                      <span className="shrink-0 text-muted-foreground">
                        [{a.ts}]
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {a.agent} · {a.tool} · {a.args} ·{" "}
                        {a.allowed ? `allowed (${a.approved_by})` : "DENIED"} ·{" "}
                        {a.ok ? "ok" : "failed"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}