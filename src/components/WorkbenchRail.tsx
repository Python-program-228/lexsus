import {
  ActivityIcon,
  BrainIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GlobeIcon,
  MessageCircleIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export type View = "trace" | "git" | "handoff" | "memory" | "bridge";

const NAV: { view: View; label: string; icon: typeof ActivityIcon }[] = [
  { view: "trace", label: "Live activity trace", icon: ActivityIcon },
  { view: "git", label: "Git", icon: GitBranchIcon },
  { view: "handoff", label: "Handoff", icon: MessageCircleIcon },
  { view: "memory", label: "Project memory", icon: BrainIcon },
  { view: "bridge", label: "Web-AI bridge", icon: GlobeIcon },
];

interface WorkbenchRailProps {
  view: View;
  onViewChange: (view: View) => void;
  paired: boolean;
  onOpenProject: () => void;
}

/**
 * Left icon rail of the workbench: brand mark, the view switcher, and
 * the project / pairing entry point pinned to the bottom.
 */
export default function WorkbenchRail({
  view,
  onViewChange,
  paired,
  onOpenProject,
}: WorkbenchRailProps) {
  return (
    <nav className="glass-sidebar flex z-10 w-13 shrink-0 flex-col items-center gap-1.5 border-r py-3">
      <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <TerminalIcon className="size-4" />
      </div>

      {NAV.map(({ view: v, label, icon: Icon }) => (
        <Tooltip key={v}>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={label}
                aria-current={view === v ? "page" : undefined}
                onClick={() => onViewChange(v)}
                className={cn(
                  "relative",
                  view === v && "bg-muted text-foreground",
                )}
              />
            }
          >
            <Icon />
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      ))}

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Project and pairing"
                onClick={onOpenProject}
              />
            }
          >
            <FolderOpenIcon />
          </TooltipTrigger>
          <TooltipContent side="right">Project &amp; pairing</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={paired ? "Extension paired" : "No extension paired"}
                className="flex size-4 items-center justify-center"
              />
            }
          >
            <span
              className={cn(
                "size-2 rounded-full",
                paired ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
          </TooltipTrigger>
          <TooltipContent side="right">
            {paired ? "Extension paired" : "Not paired"}
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
