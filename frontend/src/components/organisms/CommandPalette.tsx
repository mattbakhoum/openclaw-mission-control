"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bot,
  Boxes,
  Building2,
  CheckCircle2,
  CornerDownLeft,
  Folder,
  LayoutGrid,
  Microscope,
  Network,
  Settings,
  Sparkles,
  Store,
  Tags,
} from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";

type CommandAction = {
  label: string;
  icon: typeof Activity;
  href?: string;
  external?: boolean;
  shortcut?: string;
  group: "Navigate" | "External" | "System";
};

const ACTIONS: CommandAction[] = [
  { label: "Memory Constellation", icon: Sparkles, href: "/constellation", group: "Navigate" },
  { label: "Dashboard", icon: BarChart3, href: "/dashboard", group: "Navigate" },
  { label: "Live feed", icon: Activity, href: "/activity", group: "Navigate" },
  { label: "Traces (Langfuse)", icon: Microscope, href: "/traces", group: "Navigate" },
  { label: "Feeds (FreshRSS)", icon: Activity, href: "/feeds", group: "Navigate" },
  { label: "Board groups", icon: Folder, href: "/board-groups", group: "Navigate" },
  { label: "Boards", icon: LayoutGrid, href: "/boards", group: "Navigate" },
  { label: "Tags", icon: Tags, href: "/tags", group: "Navigate" },
  { label: "Approvals", icon: CheckCircle2, href: "/approvals", group: "Navigate" },
  { label: "Skills marketplace", icon: Store, href: "/skills/marketplace", group: "Navigate" },
  { label: "Skill packs", icon: Boxes, href: "/skills/packs", group: "Navigate" },
  { label: "Agents", icon: Bot, href: "/agents", group: "Navigate" },
  { label: "Gateways", icon: Network, href: "/gateways", group: "Navigate" },
  { label: "Organization", icon: Building2, href: "/organization", group: "Navigate" },
  { label: "Settings", icon: Settings, href: "/settings", group: "Navigate" },
  {
    label: "Langfuse (full app)",
    icon: Microscope,
    href: "https://forge.tail2cdf70.ts.net:8090",
    external: true,
    group: "External",
  },
  {
    label: "FreshRSS",
    icon: Activity,
    href: "https://forge.tail2cdf70.ts.net:8091",
    external: true,
    group: "External",
  },
  {
    label: "Qdrant",
    icon: Network,
    href: "https://forge.tail2cdf70.ts.net/qdrant",
    external: true,
    group: "External",
  },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const run = (action: CommandAction) => {
    setOpen(false);
    if (!action.href) return;
    if (action.external) {
      window.open(action.href, "_blank", "noopener,noreferrer");
    } else {
      router.push(action.href);
    }
  };

  if (!open) return null;

  const groups = Array.from(new Set(ACTIONS.map((a) => a.group)));

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 backdrop-blur-sm pt-[16vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl rounded-xl border border-strong bg-[color:var(--surface)] shadow-[0_24px_64px_-12px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter className="rounded-xl">
          <CommandInput
            placeholder="Jump to anywhere on BAKHOUM·OS…"
            autoFocus
          />
          <CommandList className="max-h-[420px]">
            <CommandEmpty>No matches.</CommandEmpty>
            {groups.map((group, idx) => (
              <div key={group}>
                {idx > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={group}>
                  {ACTIONS.filter((a) => a.group === group).map((action) => {
                    const Icon = action.icon;
                    return (
                      <CommandItem
                        key={action.label}
                        value={action.label}
                        onSelect={() => run(action)}
                        className="gap-3"
                      >
                        <Icon className="h-4 w-4 text-[color:var(--accent)]" />
                        <span className="text-strong">{action.label}</span>
                        {action.external ? (
                          <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-quiet">
                            new tab
                          </span>
                        ) : (
                          <CornerDownLeft className="ml-auto h-3.5 w-3.5 text-quiet" />
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
          <div className="flex items-center justify-between border-t border-strong px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-quiet">
            <span>↑↓ navigate · ↵ open · esc dismiss</span>
            <CommandShortcut>⌘K</CommandShortcut>
          </div>
        </Command>
      </div>
    </div>
  );
}
