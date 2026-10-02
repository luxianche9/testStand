import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "./cn";
import { Tooltip } from "./tooltip";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md",
    "font-medium outline-none transition-[color,background-color,border-color,opacity] duration-120",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-signal",
    "disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"
  ],
  {
    variants: {
      variant: {
        primary: [
          "bg-signal text-signal-fg hover:bg-signal/88 active:bg-signal/80",
          "disabled:bg-surface-3 disabled:text-fg-2"
        ],
        secondary: [
          "border border-line-strong bg-surface-1 text-fg",
          "hover:bg-surface-2 active:bg-surface-3"
        ],
        outline: "border border-line-strong text-fg hover:bg-surface-2",
        ghost: "text-fg-2 hover:bg-surface-2 hover:text-fg aria-pressed:bg-surface-2 aria-pressed:text-fg",
        danger: "border border-fail/40 bg-fail/12 text-fail hover:bg-fail/20",
        link: "h-auto px-0 text-signal underline-offset-4 hover:underline"
      },
      size: {
        xs: "h-6 px-2 text-xs",
        sm: "h-7 px-2.5 text-sm",
        md: "h-8 px-3 text-sm",
        lg: "h-9 px-4 text-base",
        icon: "size-7",
        "icon-sm": "size-6",
        "icon-xs": "size-5 rounded-sm"
      }
    },
    defaultVariants: { variant: "secondary", size: "sm" }
  }
);

export type ButtonProps = React.ComponentPropsWithoutRef<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, type = "button", ...props },
  ref
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      type={type}
      data-variant={variant ?? "secondary"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

export type IconButtonProps = Omit<ButtonProps, "size"> & {
  /** Accessible name; also shown as the tooltip unless `tooltip` is false. */
  label: string;
  size?: "icon" | "icon-sm" | "icon-xs";
  tooltip?: boolean;
  side?: "top" | "bottom" | "left" | "right";
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "icon", variant = "ghost", tooltip = true, side = "bottom", ...props },
  ref
) {
  const button = <Button ref={ref} aria-label={label} variant={variant} size={size} {...props} />;
  return tooltip ? <Tooltip content={label} side={side}>{button}</Tooltip> : button;
});
