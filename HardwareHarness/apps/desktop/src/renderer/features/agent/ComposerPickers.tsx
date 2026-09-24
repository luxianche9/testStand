import { BotIcon, CheckIcon, ChevronDownIcon, FileCodeIcon, SearchIcon, SlashIcon, TerminalIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { Button, cn, IconButton, Input, Spinner, Tooltip } from "../../ui";
import {
  formatContext,
  type OpenCodeCatalog,
  type OpenCodeCommandOption,
  type OpenCodeFileOption,
  type OpenCodeSelection
} from "./composer-model";

const itemClass = cn(
  "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-start text-sm text-fg outline-none",
  "transition-colors duration-120 hover:bg-surface-2 focus-visible:bg-surface-2"
);
const pickerTriggerClass = "min-w-0 justify-start gap-1 px-1.5 font-normal text-fg-2";

function PickerContent({ className, ...props }: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={8}
        collisionPadding={12}
        className={cn(
          "z-[100] animate-fade-in overflow-hidden rounded-md border border-line-strong bg-surface-3 text-fg",
          "shadow-overlay outline-none",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PickerSearch({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className="relative border-b border-line p-1.5">
      <SearchIcon
        aria-hidden
        className="pointer-events-none absolute start-3.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3"
      />
      <Input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={label}
        aria-label={label}
        className="h-7 ps-7"
      />
    </div>
  );
}

function PickerLabel({ children }: { children: ReactNode }) {
  return <div className="tf-label px-2 pt-1.5 pb-1">{children}</div>;
}

function PickerEmpty({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-fg-3">{children}</div>;
}

function PickerLoading({ children }: { children: ReactNode }) {
  return <PickerEmpty><Spinner className="size-3.5" />{children}</PickerEmpty>;
}

type PopoverState = { open: boolean; onOpenChange: (open: boolean) => void; onToggle: () => void };
type Search = { query: string; onQueryChange: (query: string) => void };

function PickerTrigger({ label, hint, onToggle, children }: {
  label: string;
  hint: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={hint} side="top">
      <PopoverPrimitive.Trigger asChild>
        <IconButton label={label} tooltip={false} size="icon-sm" onClick={onToggle}>{children}</IconButton>
      </PopoverPrimitive.Trigger>
    </Tooltip>
  );
}

export function FilePicker({ open, onOpenChange, onToggle, query, onQueryChange, files, loading, onPick }:
  PopoverState & Search & {
    files: OpenCodeFileOption[];
    loading: boolean;
    onPick: (file: OpenCodeFileOption) => void;
  }) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PickerTrigger label="添加工程文件" hint="添加工程文件（@）" onToggle={onToggle}>
        <FileCodeIcon />
      </PickerTrigger>
      <PickerContent align="start" side="top" className="w-80">
        <PickerSearch value={query} onChange={onQueryChange} label="搜索工程文件" />
        <div className="max-h-64 overflow-y-auto p-1">
          {!query && files.length > 0 && <PickerLabel>最近使用</PickerLabel>}
          {loading && <PickerLoading>正在搜索</PickerLoading>}
          {!loading && files.map((file) => (
            <button
              key={file.path}
              type="button"
              className={cn(itemClass, "items-center")}
              onClick={() => onPick(file)}
            >
              <FileCodeIcon aria-hidden className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
            </button>
          ))}
          {!loading && !files.length && <PickerEmpty>{query ? "没有匹配文件" : "输入文件名开始搜索"}</PickerEmpty>}
        </div>
      </PickerContent>
    </PopoverPrimitive.Root>
  );
}

export function CommandPicker({ open, onOpenChange, onToggle, query, onQueryChange, commands, loading, onPick }:
  PopoverState & Search & {
    commands: OpenCodeCommandOption[];
    loading: boolean;
    onPick: (command: OpenCodeCommandOption) => void;
  }) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PickerTrigger label="打开命令菜单" hint="OpenCode 命令（/）" onToggle={onToggle}>
        <SlashIcon />
      </PickerTrigger>
      <PickerContent align="start" side="top" className="w-80">
        <PickerSearch value={query} onChange={onQueryChange} label="搜索命令" />
        <div className="max-h-64 overflow-y-auto p-1">
          {loading && <PickerLoading>正在读取命令</PickerLoading>}
          {!loading && commands.map((command) => (
            <button key={command.name} type="button" className={itemClass} onClick={() => onPick(command)}>
              <TerminalIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs font-medium">/{command.name}</span>
                {command.description && (
                  <span className="block truncate text-2xs text-fg-3">{command.description}</span>
                )}
              </span>
            </button>
          ))}
          {!loading && !commands.length && <PickerEmpty>没有匹配命令</PickerEmpty>}
        </div>
      </PickerContent>
    </PopoverPrimitive.Root>
  );
}

type SelectionProps = {
  catalog: OpenCodeCatalog;
  selection: OpenCodeSelection;
  onSelectionChange: (selection: OpenCodeSelection) => void;
};

export function ModelPicker({ catalog, selection, onSelectionChange }: SelectionProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = selection.model;
  const isCurrent = (item: { providerID: string; modelID: string }) =>
    item.providerID === current.providerID && item.modelID === current.modelID;
  const selected = catalog.models.find(isCurrent);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (item: OpenCodeCatalog["models"][number]) =>
    `${item.providerName} ${item.name} ${item.modelID}`.toLocaleLowerCase().includes(needle);
  const models = catalog.models.filter((item) => !needle || matches(item)).slice(0, 60);
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="ghost" size="xs" className={cn(pickerTriggerClass, "max-w-36")} aria-label="选择模型">
          <span className="truncate font-mono text-2xs">{selected?.name ?? current.modelID}</span>
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </Button>
      </PopoverPrimitive.Trigger>
      <PickerContent align="end" side="top" className="w-80">
        <PickerSearch value={query} onChange={setQuery} label="搜索模型" />
        <div className="max-h-72 overflow-y-auto p-1">
          {catalog.loading && <PickerLoading>正在读取模型</PickerLoading>}
          {models.map((model) => {
            const context = formatContext(model.context);
            const pick = () => {
              onSelectionChange({ ...selection, model: { providerID: model.providerID, modelID: model.modelID } });
              setOpen(false);
              setQuery("");
            };
            return (
              <button key={`${model.providerID}/${model.modelID}`} type="button" className={itemClass} onClick={pick}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{model.name}</span>
                  <span className="tf-num block truncate text-2xs text-fg-3">
                    {model.providerName}{context ? ` · ${context}` : ""}
                  </span>
                </span>
                {isCurrent(model) && <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-signal" />}
              </button>
            );
          })}
          {!catalog.loading && !models.length && <PickerEmpty>没有匹配模型</PickerEmpty>}
        </div>
      </PickerContent>
    </PopoverPrimitive.Root>
  );
}

export function AgentPicker({ catalog, selection, onSelectionChange }: SelectionProps) {
  const agents = catalog.agents.filter((agent) => agent.mode !== "subagent");
  const selected = agents.find((item) => item.id === selection.agent);
  if (catalog.loading && !agents.length) {
    return <span className="grid size-6 place-items-center text-fg-3"><Spinner className="size-3" /></span>;
  }
  if (!agents.length) return null;
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <Button variant="ghost" size="xs" className={cn(pickerTriggerClass, "max-w-24")} aria-label="选择 Agent">
          <BotIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-2xs">{selected?.id ?? "Agent"}</span>
        </Button>
      </PopoverPrimitive.Trigger>
      <PickerContent align="end" side="top" className="w-64">
        <div className="p-1">
          {agents.map((agent) => (
            <PopoverPrimitive.Close key={agent.id} asChild>
              <button
                type="button"
                className={itemClass}
                onClick={() => onSelectionChange({ ...selection, agent: agent.id })}
              >
                <BotIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-xs font-medium">{agent.id}</span>
                  {agent.description && (
                    <span className="block text-2xs leading-snug text-fg-3">{agent.description}</span>
                  )}
                </span>
                {agent.id === selection.agent && (
                  <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-signal" />
                )}
              </button>
            </PopoverPrimitive.Close>
          ))}
        </div>
      </PickerContent>
    </PopoverPrimitive.Root>
  );
}
