import * as React from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { cn } from "./cn";

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

export function MenuContent(
  { className, sideOffset = 4, align = "start", ...props }: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Content>
) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-[110] min-w-44 animate-fade-in overflow-hidden rounded-md border border-line-strong bg-surface-3 p-1",
          "text-sm text-fg shadow-overlay",
          className
        )}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export function MenuItem({ className, danger, shortcut, children, ...props }:
  React.ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & { danger?: boolean; shortcut?: string }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex h-7 cursor-default items-center gap-2 rounded-sm px-2 outline-none select-none",
        "data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
        "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-fg-3",
        danger && "text-fail [&_svg]:text-fail",
        className
      )}
      {...props}
    >
      {children}
      {shortcut && <span className="ml-auto pl-4 font-mono text-2xs text-fg-3">{shortcut}</span>}
    </MenuPrimitive.Item>
  );
}

export function MenuSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("mx-1 my-1 h-px bg-line", className)} {...props} />;
}

export function MenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn("tf-label px-2 pt-1.5 pb-1", className)} {...props} />;
}
