import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  BotIcon,
  CableIcon,
  FlaskConicalIcon,
  FolderOpenIcon,
  MoonIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SunIcon
} from "lucide-react";
import { Kbd, cn } from "../ui";

export type PaletteCommand = {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  shortcut?: string;
  keywords?: string;
  run: () => void;
};

export const paletteIcons = {
  manual: <ServerIcon />,
  wiring: <CableIcon />,
  plans: <FlaskConicalIcon />,
  settings: <SettingsIcon />,
  open: <FolderOpenIcon />,
  save: <SaveIcon />,
  run: <PlayIcon />,
  add: <PlusIcon />,
  ai: <BotIcon />,
  dark: <MoonIcon />,
  light: <SunIcon />
};

function matches(command: PaletteCommand, query: string) {
  if (!query) return true;
  const haystack = `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).every((term) => haystack.includes(term));
}

export function CommandPalette({ open, onOpenChange, commands }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => commands.filter((command) => matches(command, query.trim())), [commands, query]);

  useEffect(() => { if (open) { setQuery(""); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onOpenChange(false);
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((i) => Math.min(visible.length - 1, i + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); run(visible[active]); }
  };

  let lastGroup = "";
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] animate-fade-in bg-black/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          className={cn(
            "fixed top-[14vh] left-1/2 z-[101] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-dialog-in",
            "overflow-hidden rounded-lg border border-line-strong bg-surface-1 shadow-overlay outline-none"
          )}
        >
          <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>
          <div className="flex h-11 items-center gap-2 border-b border-line px-3">
            <SearchIcon className="size-4 text-fg-3" />
            <input
              autoFocus
              aria-label="搜索命令"
              role="combobox"
              aria-expanded
              aria-controls="command-palette-list"
              aria-activedescendant={visible[active] ? `command-${visible[active].id}` : undefined}
              placeholder="输入命令或页面…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-3"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-80 overflow-y-auto p-1">
            {visible.length === 0 && <p className="px-3 py-6 text-center text-sm text-fg-3">没有匹配的命令</p>}
            {visible.map((command, index) => {
              const header = command.group !== lastGroup ? command.group : undefined;
              lastGroup = command.group;
              return (
                <div key={command.id}>
                  {header && <div className="tf-label px-2 pt-2 pb-1">{header}</div>}
                  <div
                    id={`command-${command.id}`}
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    onMouseMove={() => setActive(index)}
                    onClick={() => run(command)}
                    className={cn(
                      "flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2 text-sm text-fg-2",
                      "[&_svg]:size-3.5 [&_svg]:text-fg-3",
                      index === active && "bg-surface-2 text-fg [&_svg]:text-signal"
                    )}
                  >
                    {command.icon}
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.shortcut && <Kbd>{command.shortcut}</Kbd>}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
