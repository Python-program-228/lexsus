import { useEffect, useRef, useState, type ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Chip } from "@heroui/react";
import {
  ActivityIcon,
  BookOpenIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleIcon,
  FileIcon,
  FlaskConicalIcon,
  PlayIcon,
  SquarePenIcon,
} from "lucide-react";
import type { FsEvent, TraceStep } from "../lib/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { ScrollArea } from "./ui/scroll-area";

interface TraceItem extends TraceStep {
  confirmed: boolean;
  id: number;
}

const ICONS: Record<string, ReactNode> = {
  reading: <BookOpenIcon />,
  editing: <SquarePenIcon />,
  running: <PlayIcon />,
  test: <FlaskConicalIcon />,
  error: <CircleAlertIcon className="text-destructive" />,
  fs: <FileIcon />,
};

/** Live activity trace (M1.4): parsed Claude Code steps + watcher
 *  grounding. Headroom: newest 3 expanded, older collapse into a
 *  summary line you can click to expand. */
export default function ActivityTrace() {
  const [items, setItems] = useState<TraceItem[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const idRef = useRef(0);

  useEffect(() => {
    let unlistens: UnlistenFn[] = [];
    void (async () => {
      unlistens = [
        await listen<TraceStep>("trace://step", (e) => {
          const step = e.payload;
          setItems((prev) => [
            ...prev,
            {
              ...step,
              id: ++idRef.current,
              confirmed: step.kind === "editing" ? false : step.confirmed,
            },
          ]);
        }),
        await listen<{ path: string }>("trace://confirm", (e) => {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "editing" && it.file === e.payload.path
                ? { ...it, confirmed: true }
                : it,
            ),
          );
        }),
        await listen<FsEvent>("fs://event", () => {
          setItems((prev) => [
            ...prev,
            {
              kind: "fs",
              file: null,
              command: null,
              detail: null,
              confirmed: false,
              agent: "watcher",
              ts: Date.now(),
              id: ++idRef.current,
            },
          ]);
        }),
      ];
    })();
    return () => {
      for (const u of unlistens) u();
    };
  }, []);

  // Keep the list bounded (last 500).
  const visible = items.slice(-500);
  const expanded = collapsed ? visible.slice(-3) : visible;
  const earlier = visible.slice(0, Math.max(0, visible.length - 3));
  const filesTouched = new Set(
    earlier.filter((e) => e.kind === "editing").map((e) => e.file),
  ).size;

  function renderItem(it: TraceItem) {
    const icon = ICONS[it.kind] ?? <CircleIcon />;
    const label =
      it.kind === "fs"
        ? "file changed on disk"
        : it.kind === "test" || it.kind === "error"
          ? (it.detail ?? "")
          : it.file ?? it.command ?? "";
    return (
      <li
        key={it.id}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
        {it.kind === "editing" &&
          (it.confirmed ? (
            <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
              <CheckIcon /> saved
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-400">
              waiting
            </Badge>
          ))}
        {it.kind === "running" && (
          <code className="hidden max-w-40 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground xl:block">
            {it.command}
          </code>
        )}
        <Chip
          size="sm"
          variant="soft"
          color={it.agent === "watcher" ? "default" : "accent"}
          className="shrink-0"
        >
          {it.agent}
        </Chip>
      </li>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ActivityIcon className="size-4 shrink-0 text-muted-foreground" />
          Live activity trace
        </CardTitle>
        <CardDescription>
          grounded against the filesystem watcher · {visible.length} events
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        <ScrollArea className="h-[340px] pr-3">
          {visible.length === 0 ? (
            <Empty className="h-[320px]">
              <EmptyMedia variant="icon">
                <ActivityIcon />
              </EmptyMedia>
              <EmptyContent>
                <EmptyHeader>
                  <EmptyTitle>No activity yet</EmptyTitle>
                  <EmptyDescription>
                    Start a Claude Code session in the terminal and watch its
                    steps appear here.
                  </EmptyDescription>
                </EmptyHeader>
              </EmptyContent>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {collapsed && earlier.length > 0 && (
                <li>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCollapsed(false)}
                    className="text-muted-foreground"
                  >
                    {earlier.length} earlier steps · {filesTouched} files touched
                  </Button>
                </li>
              )}
              {expanded.map(renderItem)}
              {!collapsed && (
                <li>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCollapsed(true)}
                    className="text-muted-foreground"
                  >
                    collapse older steps
                  </Button>
                </li>
              )}
            </ul>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}